import { useCallback, useMemo, useRef, type Ref } from "react";
import type { Issue, Run } from "@foundry/protocol";
import { issueEnvironmentAction, requestChanges, steerIssue } from "../../api";
import { Conversation } from "../../components/conversation/conversation";
import { issueTranscript } from "./issue-transcript";
import type { ChatMessageItem } from "../../components/conversation/conversation-types";
import type { IssueContractController } from "./use-issue-contract";
import { ContractConfirmationCard } from "./contract-confirmation-card";
import { isStatusQuestion } from "./issue-language";
import { askIssueStatus } from "./evidence-api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import "./issue-execution.css";

/** Issue transport adapter. Input, queueing and scrolling belong to Conversation. */
export function IssueConversation({
  issue,
  history = [],
  inputRef,
  onRefresh,
  contract,
}: {
  issue: Issue;
  history?: Run[];
  inputRef: Ref<HTMLTextAreaElement>;
  onRefresh: (issueId?: string) => void;
  contract?: IssueContractController;
}) {
  const statusRequest = useRef<{ text: string; key: string } | undefined>(
    undefined,
  );
  const clarifying = !!contract?.draft && issue.status !== "in_progress";
  const messages = useMemo(
    () => issueTranscript(issue, history),
    [issue, history],
  );
  const runId = issue.run?.id;
  const send = useCallback(
    async (
      text: string,
      attachments?: import("@foundry/protocol").ChatAttachment[],
    ) => {
      if (
        isStatusQuestion(text) &&
        !attachments?.length &&
        !contract?.attachments.length
      ) {
        if (statusRequest.current?.text !== text)
          statusRequest.current = { text, key: crypto.randomUUID() };
        await askIssueStatus(issue.id, text, statusRequest.current.key);
        statusRequest.current = undefined;
        onRefresh(issue.id);
        return "replied" as const;
      }
      if (clarifying && contract) return contract.send(text, attachments);
      if (contract && issue.contractState !== "confirmed")
        throw new Error("请先在“目标与约定”发起澄清，确认标准后再执行。");
      await requestChanges(issue.id, text, runId);
      onRefresh(issue.id);
      return true;
    },
    [issue, runId, onRefresh, clarifying, contract],
  );
  const steer = useCallback(
    async (text: string, executionId?: string) => {
      if (!executionId) throw new Error("No active Issue execution");
      await steerIssue(issue.id, text, executionId);
      onRefresh(issue.id);
      return true;
    },
    [issue.id, onRefresh],
  );
  const stop = useCallback(async () => {
    await issueEnvironmentAction(issue.id, "cancel");
    onRefresh(issue.id);
  }, [issue.id, onRefresh]);
  const terminal = issue.status === "accepted" || issue.status === "abandoned";
  const displayed: ChatMessageItem[] = [...messages];
  if (contract?.busy) {
    if (contract.pendingText && contract.pendingText !== issue.sourceInput)
      displayed.push({
        id: "clarification-pending-input",
        role: "user",
        text: contract.pendingText,
      });
    displayed.push({
      id: "clarification-pending",
      role: "bot",
      kind: "process",
      text: "",
      title: "正在整理目标与完成标准…",
      streaming: true,
    });
  } else if (contract && clarifying) {
    if (contract.draft?.criteria.some((c) => c.required))
      displayed.push({
        id: `confirmation-${contract.draft.id}`,
        role: "bot",
        text: <ContractConfirmationCard issue={issue} controller={contract} />,
      });
    else if (!issue.messages?.length)
      displayed.push({
        id: "clarification-welcome",
        role: "bot",
        text: "我会先和你明确目标与完成标准，确认后再开始修改。",
      });
  }
  if (contract?.error)
    displayed.push({
      id: "contract-error",
      role: "bot",
      text: (
        <Alert tone="warning" title="这一步尚未完成">
          <p>{contract.error}</p>
          {!issue.messages?.length ? (
            <Button
              disabled={contract.busy}
              variant="secondary"
              onClick={() => void contract.retryInitial().catch(() => {})}
            >
              重试目标澄清
            </Button>
          ) : null}
          <p>输入与已保存内容保留；处理原因后可再次发送。</p>
        </Alert>
      ),
    });
  return (
    <Conversation
      threadKey={issue.id}
      messages={displayed}
      inputRef={inputRef}
      composer={{ mode: "fixed", runtime: issue.runtime, model: issue.model }}
      active={issue.status === "in_progress"}
      sending={
        contract?.busy ||
        (issue.status === "pending" && issue.contractState === "confirmed")
      }
      activeExecutionId={runId}
      draftStorageKey={`foundry.issue-draft:${issue.id}`}
      inputLabel="Issue follow-up"
      sendLabel="Send issue message"
      placeholder={
        clarifying
          ? "说说想达到的结果、回答追问，或上传参考…"
          : issue.status === "in_progress"
            ? "Guide the agent while it works…"
            : "Continue this Issue in its candidate workspace…"
      }
      onSend={send}
      canSendDuringExecution={isStatusQuestion}
      attachments={clarifying ? contract?.attachments : undefined}
      attachmentUploading={contract?.uploading}
      onAttachmentsAdd={
        clarifying ? (files) => void contract?.addAttachments(files) : undefined
      }
      onAttachmentRemove={contract?.removeAttachment}
      onSteer={issue.runtime === "claude" ? steer : undefined}
      onStop={stop}
      readOnly={
        terminal ? (
          <p className="fdy-issue-conversation-note">
            {issue.status === "accepted"
              ? "Accepted into Workspace."
              : "Abandoned. Candidate and conversation history are retained."}{" "}
            Create a follow-up Issue for further changes.
          </p>
        ) : undefined
      }
    />
  );
}
