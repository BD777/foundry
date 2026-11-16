import { toast } from "../../components/ui/toast";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  PersonalAgentContextPatch,
  PersonalAgentMaintenance,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import type { ContextPatchReply } from "@bd777/foundry-protocol";
import {
  actOnWorkspaceUpkeep,
  applyWorkspaceUpkeepPatch,
  listWorkspaceUpkeep,
  previewWorkspaceUpkeepPatch,
} from "../../api";
import { Button } from "../../components/ui/button";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Disclosure, DisclosureSummary } from "../../components/ui/disclosure";
import { DividedList } from "../../components/ui/divided-list";
import { ButtonRow } from "../../components/ui/button-row";
import { FieldHint } from "../../components/ui/field";
import { Panel, PanelHeader } from "../../components/ui/panel";
import { serverErrorText } from "../../lib/errors";
import { navigateToChat } from "../../lib/in-app-navigation";
import { workspaceDenial } from "../../lib/workspace-access";

const upkeepPanel = "grid min-w-0 gap-4 p-5.5 max-[680px]:p-4";
const endedStates = ["complete", "dismissed", "superseded"];
/** Accepted changes no longer wait for the person; a conflict still does. */
const decidedStates = ["applying", "applied"];

/** A suggested change the person has not decided yet. */
function undecided(
  job: PersonalAgentMaintenance,
  patches: PersonalAgentContextPatch[],
): number {
  if (job.status !== "review" || !job.result) return 0;
  return job.result.patches.reduce((count, _patch, index) => {
    const operation = patches.find(
      (candidate) => candidate.jobId === job.id && candidate.index === index,
    );
    return (
      count + (operation && decidedStates.includes(operation.status) ? 0 : 1)
    );
  }, 0);
}

/**
 * 「项目维护」: Foundry's reviews of this project's instruction files and the
 * file changes they suggest, on the project's own page (DEV-256). It is the
 * project's, not any assistant's, so it is shown to its owner whether or not
 * an assistant is running. Applying still waits for no active conversation in
 * the project, which the server enforces.
 */
export function WorkspaceUpkeep({
  workspace,
}: {
  workspace: WorkspaceProjection;
}) {
  const { t } = useTranslation("workspaces");
  const { t: tm } = useTranslation("personalAgent");
  const denial = workspaceDenial(workspace, "owner");
  const [jobs, setJobs] = useState<PersonalAgentMaintenance[]>([]);
  const [patches, setPatches] = useState<PersonalAgentContextPatch[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [preview, setPreview] = useState<{
    jobId: string;
    revision: number;
    index: number;
    source: ContextPatchReply;
  } | null>(null);
  const read = useCallback(async () => {
    const upkeep = await listWorkspaceUpkeep(workspace.id);
    setJobs(upkeep.jobs);
    setPatches(upkeep.patches);
  }, [workspace.id]);
  useEffect(() => {
    if (!workspace.id || denial) return;
    let cancelled = false;
    read()
      .then(() => {
        if (!cancelled) setError("");
      })
      .catch((e) => {
        if (!cancelled) setError(serverErrorText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [read, workspace.id, denial]);
  const active =
    jobs.some((job) =>
      ["pending", "waiting", "starting", "running"].includes(job.status),
    ) || patches.some((patch) => patch.status === "applying");
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(
      () =>
        void read().catch((e) => {
          setError(serverErrorText(e));
        }),
      10000,
    );
    return () => clearInterval(timer);
  }, [active, read]);
  if (denial) return null;
  async function perform(key: string, action: () => Promise<unknown>) {
    setBusy(key);
    setError("");
    try {
      await action();
      await read();
    } catch (e) {
      toast({
        tone: "error",
        title: t("upkeep.title"),
        description: serverErrorText(e),
      });
    } finally {
      setBusy("");
    }
  }
  function status(value: string) {
    const known = [
      "pending",
      "waiting",
      "starting",
      "running",
      "review",
      "complete",
      "failed",
      "dismissed",
      "superseded",
      "applying",
      "applied",
      "conflict",
    ];
    return known.includes(value)
      ? tm(`maintenance.states.${value}` as never)
      : value;
  }
  function reason(value: string) {
    const known = [
      "assistant_paused",
      "no_default_assistant",
      "maintenance_busy",
      "daily_maintenance_limit",
      "role_configuration_unavailable",
      "role_configuration_changed",
      "device_offline",
      "target_device_offline",
      "device_offline_too_long",
      "workspace_archived",
      "workspace_unavailable",
      "workspace_gone",
      "source_gone",
      "source_inactive",
      "retry_scheduled",
      "worker_update_required",
      "source_unavailable",
      "sandbox_unavailable",
      "account_unavailable",
      "input_acceptance_failed",
      "invalid_review_result",
      "native_failed",
      "native_canceled",
      "waiting_for_device_receipt",
      "source_changed_review_again",
      "permission_changed",
      "source_location_changed",
      "receipt_mismatch",
      "input_moved",
    ];
    return known.includes(value)
      ? tm(`maintenance.reasons.${value}` as never)
      : value;
  }
  const waiting = jobs.reduce(
    (count, job) => count + undecided(job, patches),
    0,
  );
  const current = jobs.filter((job) => !endedStates.includes(job.status));
  const ended = jobs.filter((job) => endedStates.includes(job.status));
  function jobRow(job: PersonalAgentMaintenance) {
    return (
      <li key={job.id} className="grid min-w-0 gap-1.5 wrap-anywhere">
        <p>
          {status(job.status)}
          {job.reason ? ` · ${reason(job.reason)}` : ""}
        </p>
        {job.result?.summary ? <p>{job.result.summary}</p> : null}
        {job.result?.findings.length ? (
          <ul className="min-w-0 wrap-anywhere">
            {job.result.findings.map((finding, index) => (
              <li key={index}>
                <p>{finding.summary}</p>
                <FieldHint>{finding.sourceRefs.join(" · ")}</FieldHint>
              </li>
            ))}
          </ul>
        ) : null}
        <ButtonRow>
          {job.sessionId ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => navigateToChat(job.sessionId!, job.workspaceId)}
            >
              {tm("maintenance.openRun")}
            </Button>
          ) : null}
          {["failed", "waiting"].includes(job.status) && job.attempt < 2 ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={!!busy}
              onClick={() =>
                void perform(job.id, () =>
                  actOnWorkspaceUpkeep(
                    workspace.id,
                    job.id,
                    job.revision,
                    "retry",
                  ),
                )
              }
            >
              {tm("maintenance.retry")}
            </Button>
          ) : null}
          {["review", "failed", "pending", "waiting"].includes(job.status) &&
          (!job.inputId || ["review", "failed"].includes(job.status)) ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={!!busy}
              onClick={() =>
                void perform(job.id, () =>
                  actOnWorkspaceUpkeep(
                    workspace.id,
                    job.id,
                    job.revision,
                    "dismiss",
                  ),
                )
              }
            >
              {tm("maintenance.dismiss")}
            </Button>
          ) : null}
        </ButtonRow>
        {job.status === "review"
          ? job.result?.patches.map((patch, index) => {
              const operation = patches.find(
                (candidate) =>
                  candidate.jobId === job.id && candidate.index === index,
              );
              const shown =
                preview?.jobId === job.id &&
                preview.index === index &&
                preview.revision === job.revision
                  ? preview.source
                  : null;
              const baseHash = patch.baseHash || "missing";
              return (
                <div
                  key={patch.path}
                  className="grid min-w-0 justify-items-start gap-1.5 border-t border-line-soft pt-2"
                >
                  <p>
                    {patch.path} · {patch.reason}
                  </p>
                  {operation ? (
                    <FieldHint>
                      {status(operation.status)}
                      {operation.reason ? ` · ${reason(operation.reason)}` : ""}
                    </FieldHint>
                  ) : null}
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!!busy}
                    onClick={() =>
                      void perform(`${job.id}:${index}`, async () => {
                        setPreview(null);
                        const source = await previewWorkspaceUpkeepPatch(
                          workspace.id,
                          job.id,
                          job.revision,
                          index,
                        );
                        setPreview({
                          jobId: job.id,
                          revision: job.revision,
                          index,
                          source,
                        });
                      })
                    }
                  >
                    {tm("maintenance.preview")}
                  </Button>
                  {shown ? (
                    <>
                      <FieldHint>
                        {baseHash === "missing"
                          ? tm("maintenance.newFile")
                          : tm("maintenance.modifiedFile")}
                      </FieldHint>
                      <FieldHint>{tm("maintenance.current")}</FieldHint>
                      <pre className="max-h-80 overflow-auto bg-panel-soft p-3 text-sm wrap-anywhere whitespace-pre-wrap">
                        {shown.hash === "missing"
                          ? tm("maintenance.missing")
                          : shown.content}
                      </pre>
                      <FieldHint>{tm("maintenance.proposed")}</FieldHint>
                      <pre className="max-h-80 overflow-auto bg-panel-soft p-3 text-sm wrap-anywhere whitespace-pre-wrap">
                        {patch.content}
                      </pre>
                      {shown.hash !== baseHash ? (
                        <Alert tone="warning" title={tm("maintenance.stale")} />
                      ) : (
                        <Button
                          size="sm"
                          disabled={!!busy || !!operation}
                          onClick={() =>
                            void perform(`${job.id}:${index}`, () =>
                              applyWorkspaceUpkeepPatch(
                                workspace.id,
                                job.id,
                                job.revision,
                                index,
                                shown.hash,
                              ),
                            )
                          }
                        >
                          {tm("maintenance.apply")}
                        </Button>
                      )}
                    </>
                  ) : null}
                </div>
              );
            })
          : null}
      </li>
    );
  }
  return (
    <Panel className={upkeepPanel}>
      <PanelHeader>
        <div>
          <h2>{t("upkeep.title")}</h2>
          <FieldHint className="mt-1 mb-0 leading-[1.6]">
            {t("upkeep.description")}
          </FieldHint>
        </div>
        {waiting > 0 ? (
          <Badge tone="warn">{t("upkeep.waiting", { count: waiting })}</Badge>
        ) : null}
      </PanelHeader>
      {error ? <Alert tone="error" size="compact" title={error} /> : null}
      {!jobs.length ? (
        <FieldHint className="m-0 leading-[1.6]">{t("upkeep.empty")}</FieldHint>
      ) : null}
      {current.length ? (
        <DividedList density="cozy">{current.map(jobRow)}</DividedList>
      ) : null}
      {ended.length ? (
        <Disclosure>
          <DisclosureSummary>
            {t("upkeep.ended", { count: ended.length })}
          </DisclosureSummary>
          <DividedList density="cozy">{ended.map(jobRow)}</DividedList>
        </Disclosure>
      ) : null}
    </Panel>
  );
}
