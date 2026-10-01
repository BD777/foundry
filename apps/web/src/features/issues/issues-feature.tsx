import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  Issue,
  AgentProjection,
  AgentProfileProjection,
  ClaudeEffort,
  CodexReasoningEffort,
  IssueStatus,
  ProviderHealth,
  WorkerRuntimeId,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { createIssue } from "../../api";
import { IssueListStatus, WorkerUpdateNotice } from "./issue-notices";
import { useIssueModels } from "./use-issue-models";
import { IssueCard } from "./issue-board-card";
import { AgentComposer } from "../../components/ui/agent-composer";
import { AgentPickerFooter } from "../../components/ui/agent-picker-footer";
import { IssueBoard, IssueListTable, IssuesScreen } from "./issue-workspace";
import { RuntimeMark, runtimeMeta } from "../../components/ui/runtime-mark";
import {
  buildPickerAgentOptions,
  canonicalPickerAgents,
  firstDisabledDeviceId,
} from "../../lib/agent-picker";
import { navigateToDeviceAgents } from "../../lib/in-app-navigation";
import { workspaceDenial } from "../../lib/workspace-access";
import { WorkspaceStrip, WorkspaceStripControl } from "./workspace-strip";
import {
  issueDisplayId,
  issueSortValue,
  issueTemplate,
  statusMeta,
  issueStatuses,
  issueDisplayStatus,
} from "../../lib/issue-meta";

type BoardMode = "board" | "list";

export interface IssueDraftRequest {
  id: number;
  runtime?: WorkerRuntimeId;
  source?: string;
}

export type IssuesFeatureEvent =
  | { issue: Issue; type: "issue.created" }
  | { issueId: string; type: "issue.open.requested" }
  | { message: string; type: "notice.requested" };

export interface IssuesFeatureProps {
  draftRequest?: IssueDraftRequest;
  issues: Issue[];
  onEvent: (event: IssuesFeatureEvent) => Promise<void> | void;
  selectedIssueId?: string;
  workspace: WorkspaceProjection;
  providerHealth: ProviderHealth[];
  agents: AgentProjection[];
  profiles: AgentProfileProjection[];
  /** The workspace's worker can execute Issues; false for an older one. */
  workerRunsIssues?: boolean;
}

/**
 * The issue page owns composer and board interaction state. Its public contract
 * is domain input plus semantic events; draft text, refs, feedback, and view
 * mode remain private.
 */
export function IssuesFeature({
  workerRunsIssues,
  draftRequest,
  issues,
  onEvent,
  selectedIssueId,
  workspace,
  providerHealth,
  agents,
  profiles,
}: IssuesFeatureProps) {
  const { t } = useTranslation("issues");
  const [boardMode, setBoardMode] = useState<BoardMode>("board");
  const [draft, setDraft] = useState("");
  const [feedback, setFeedback] = useState("");
  const availableRuntime = providerHealth.find(
    (provider) => provider.status === "healthy",
  )?.provider;
  const [runtime, setRuntime] = useState<WorkerRuntimeId>(
    availableRuntime ?? "claude",
  );
  const runtimeReady = providerHealth.some(
    (provider) =>
      provider.provider === runtime && provider.status === "healthy",
  );
  // New issues never resurrect a promoted device configuration: the pair is
  // represented by the server definition only. Genuinely distinct same-named
  // connections stay separate.
  const pickerAgents = useMemo(
    () => canonicalPickerAgents(agents, profiles),
    [agents, profiles],
  );
  const modelSettings = useIssueModels(
    runtime,
    pickerAgents,
    profiles,
    workspace.id,
  );
  const agentOptions = useMemo(
    () => buildPickerAgentOptions(agents, profiles),
    [agents, profiles],
  );
  const disabledAgentDeviceId = firstDisabledDeviceId(agentOptions);
  const [submitting, setSubmitting] = useState(false);
  const createDenial = workspaceDenial(workspace, "member");
  const submitBlocked =
    submitting || !runtimeReady || !draft.trim() || !!createDenial;
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const lastDraftRequestIdRef = useRef<number | undefined>(undefined);

  const sortedIssues = [...issues].sort(
    (left, right) => issueSortValue(left) - issueSortValue(right),
  );

  useEffect(() => {
    if (!runtimeReady && availableRuntime) setRuntime(availableRuntime);
  }, [availableRuntime, runtimeReady]);

  useEffect(() => {
    if (!draftRequest || lastDraftRequestIdRef.current === draftRequest.id) {
      return;
    }
    lastDraftRequestIdRef.current = draftRequest.id;
    setBoardMode("board");
    setFeedback("");
    if (draftRequest.source !== undefined) {
      setDraft(draftRequest.source);
    }
    if (draftRequest.runtime && draftRequest.runtime !== "mock") {
      setRuntime(draftRequest.runtime);
    }
    const frame = window.requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [draftRequest]);

  function loadDraft(
    source: string,
    nextRuntime: WorkerRuntimeId = runtime,
  ): void {
    setBoardMode("board");
    setDraft(source);
    setRuntime(
      nextRuntime === "mock" ? (availableRuntime ?? "claude") : nextRuntime,
    );
    setFeedback("");
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }

  async function submit(): Promise<void> {
    if (!runtimeReady || runtime === "mock") {
      setFeedback(t("notices.needsRealAgent"));
      return;
    }
    const sourceInput = composerRef.current?.value ?? draft;
    if (submitting) {
      await onEvent({
        message: t("notices.stillSaving"),
        type: "notice.requested",
      });
      return;
    }
    if (sourceInput.trim() === "") {
      await onEvent({
        message: t("notices.describeFirst"),
        type: "notice.requested",
      });
      composerRef.current?.focus();
      return;
    }
    try {
      setSubmitting(true);
      setFeedback("");
      await onEvent({
        message: t("notices.creating"),
        type: "notice.requested",
      });
      const issue = await createIssue({
        runtime,
        model: modelSettings.model || undefined,
        codexSpeed: runtime === "codex" ? modelSettings.speed : undefined,
        profileId: modelSettings.profileId,
        claudeEffort:
          runtime === "claude"
            ? (modelSettings.effort as ClaudeEffort)
            : undefined,
        codexReasoningEffort:
          runtime === "codex"
            ? (modelSettings.effort as CodexReasoningEffort)
            : undefined,
        sourceInput: sourceInput.trim(),
        workspaceId: workspace.id,
      });
      // Historical drafts must not dispatch an Agent merely by being opened.
      try {
        sessionStorage.setItem(
          `foundry.initial-clarification:${issue.id}`,
          "pending",
        );
      } catch {}
      setDraft("");
      setBoardMode("board");
      setFeedback(t("notices.created"));
      await onEvent({ issue, type: "issue.created" });
    } catch {
      setFeedback("");
      await onEvent({
        message: t("notices.unreachable"),
        type: "notice.requested",
      });
    } finally {
      setSubmitting(false);
    }
  }

  const columns = issueStatuses.map((status) => ({
    status,
    label: statusMeta(status).label,
  }));
  const boardItems = sortedIssues.map((issue) => ({
    content: (
      <IssueCard
        issue={issue}
        onOpen={() =>
          void onEvent({ issueId: issue.id, type: "issue.open.requested" })
        }
        selected={issue.id === selectedIssueId}
      />
    ),
    id: issue.id,
    status: issueDisplayStatus(issue),
  }));
  const listRows = sortedIssues.map((issue) => {
    return {
      id: issue.id,
      issueId: issueDisplayId(issue),
      onOpen: () =>
        void onEvent({ issueId: issue.id, type: "issue.open.requested" }),
      runtimeLabel: runtimeMeta(issue.runtime).label,
      selected: issue.id === selectedIssueId,
      status: <IssueListStatus issue={issue} />,
      title: issue.title,
      updatedLabel: issue.updatedLabel.replace("Updated ", ""),
    };
  });

  return (
    <IssuesScreen>
      <WorkspaceStrip
        acceptedCount={
          issues.filter((issue) => issue.status === "accepted").length
        }
        baseline={workspace.baseline}
        iconLabel="A"
        localPath={workspace.localPath.replace("/Users/you/", "~/")}
        resolvedCount={workspace.resolvedCount}
        viewControl={
          <WorkspaceStripControl
            ariaLabel={t("page.viewLabel")}
            onValueChange={setBoardMode}
            options={[
              { label: t("page.board"), value: "board" },
              { label: t("page.list"), value: "list" },
            ]}
            value={boardMode}
          />
        }
        workspaceName={workspace.name}
      />

      {workerRunsIssues === false ? <WorkerUpdateNotice /> : null}

      <AgentComposer
        className="fdy-issue-composer"
        showPermissions={false}
        side="bottom"
        controlsDisabled={submitting}
        input={{
          "aria-label": t("page.inputLabel"),
          ref: composerRef,
          value: draft,
          placeholder: t("page.placeholder"),
          onChange: (event) => {
            setFeedback("");
            setDraft(event.target.value);
          },
          onSubmit: () => void submit(),
          submitDisabled: submitBlocked,
        }}
        agentLabel={t("page.agentLabel")}
        agentOptions={agentOptions}
        agentPickerFooter={
          <AgentPickerFooter
            deviceId={disabledAgentDeviceId}
            onManage={navigateToDeviceAgents}
          />
        }
        agentValue={modelSettings.agent?.id ?? ""}
        onAgentChange={(value) => {
          const agent = pickerAgents.find((item) => item.id === value);
          if (agent) {
            setRuntime(agent.provider);
            modelSettings.selectAgent(value);
          }
        }}
        runtimeControls={modelSettings.controls}
        actionLabel={submitting ? t("page.opening") : t("page.submit")}
        actionDisabled={submitBlocked}
        onAction={() => void submit()}
      >
        <span className="fdy-issue-composer-status" role="status">
          {createDenial ||
            feedback ||
            (!runtimeReady ? t("page.needsAgent") : t("page.hint"))}
        </span>
      </AgentComposer>

      {boardMode === "board" ? (
        <IssueBoard
          columns={columns}
          issues={boardItems}
          onAdd={(status) => loadDraft(issueTemplate(status))}
        />
      ) : (
        <IssueListTable rows={listRows} />
      )}
    </IssuesScreen>
  );
}
