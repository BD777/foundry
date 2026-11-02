import { useCallback, useMemo, useRef, type Ref } from "react";
import { useTranslation } from "react-i18next";
import type { Issue } from "@bd777/foundry-protocol";
import {
  issueEnvironmentAction,
  sendIssueMessage,
  steerIssue,
} from "../../api";
import { IssueQuestionCard } from "./issue-question-card";
import { Conversation } from "../../components/conversation/conversation";
import { conversationStoragePrefixes } from "../../components/conversation/conversation-storage";
import { issueTranscript } from "./issue-transcript";
import { useIssueExecutions } from "./use-issue-executions";
import type { ChatMessageItem } from "../../components/conversation/conversation-types";
import type { IssueContractController } from "./use-issue-contract";
import { ContractConfirmationCard } from "./contract-confirmation-card";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { isIssueClosed } from "../../lib/issue-meta";

/** Issue transport adapter. Input, queueing and scrolling belong to Conversation. */
export function IssueConversation({
  issue,
  inputRef,
  contract,
}: {
  issue: Issue;
  inputRef: Ref<HTMLTextAreaElement>;
  contract?: IssueContractController;
}) {
  const { t } = useTranslation("issueDetail");
  // A message sent again after a lost answer keeps its key.
  const messageRequest = useRef<{ text: string; key: string } | undefined>(
    undefined,
  );
  const clarifying = !!contract?.draft && issue.status !== "in_progress";
  const executions = useIssueExecutions(issue);
  const messages = useMemo(
    () => issueTranscript(issue, executions.executions),
    [issue, executions.executions],
  );
  const runId = issue.run?.id;
  const send = useCallback(
    async (
      text: string,
      attachments?: import("@bd777/foundry-protocol").ChatAttachment[],
    ) => {
      // The server decides where a message is due; a draft shown takes it
      // with its references, bound to that draft.
      if (clarifying && contract) return contract.send(text, attachments);
      if (messageRequest.current?.text !== text)
        messageRequest.current = { text, key: crypto.randomUUID() };
      const result = await sendIssueMessage(
        issue.id,
        { text, expectedRunId: runId },
        messageRequest.current.key,
      );
      messageRequest.current = undefined;
      return result.route === "status" ? ("replied" as const) : true;
    },
    [issue.id, runId, clarifying, contract],
  );
  const steer = useCallback(
    async (
      text: string,
      executionId?: string,
      attachments?: import("@bd777/foundry-protocol").ChatAttachment[],
    ) => {
      if (!executionId) throw new Error(t("conversation.noExecution"));
      // An execution takes text only; files wait for the next turn.
      if (attachments?.length) throw new Error(t("conversation.steerTextOnly"));
      await steerIssue(issue.id, text, executionId);
      return true;
    },
    [issue.id, t],
  );
  const stop = useCallback(async () => {
    await issueEnvironmentAction(issue.id, "cancel");
  }, [issue.id]);
  const terminal = isIssueClosed(issue);
  const displayed: ChatMessageItem[] = [...messages];
  if (contract?.busy || contract?.replying) {
    if (
      contract.busy &&
      contract.pendingText &&
      contract.pendingText !== issue.sourceInput
    )
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
      title: t("conversation.organizing"),
      streaming: true,
    });
  } else if (contract && clarifying) {
    if (contract.replyFailure)
      displayed.push({
        id: "clarification-failed",
        role: "bot",
        text: (
          <Alert tone="warning" title={t("conversation.replyFailedTitle")}>
            <p>{contract.replyFailure}</p>
            <Button
              disabled={contract.busy}
              variant="secondary"
              onClick={() => void contract.retryReply()}
            >
              {t("conversation.retryReply")}
            </Button>
            <p>{t("conversation.replyKeptNote")}</p>
          </Alert>
        ),
      });
    if (contract.draft?.criteria.some((c) => c.required))
      displayed.push({
        id: `confirmation-${contract.draft.id}`,
        role: "bot",
        text: <ContractConfirmationCard issue={issue} controller={contract} />,
      });
    // The server starts clarifying a new Issue's request; when it could
    // not, the person starts it again here.
    else if (!issue.messages?.length)
      displayed.push({
        id: "clarification-welcome",
        role: "bot",
        text: (
          <>
            <p>{t("conversation.welcome")}</p>
            <Button
              disabled={contract.busy}
              variant="secondary"
              onClick={() => void contract.retryInitial()}
            >
              {t("conversation.retryClarify")}
            </Button>
          </>
        ),
      });
  }
  if (issue.question)
    displayed.push({
      id: `question-${issue.question.id}`,
      role: "bot",
      text: <IssueQuestionCard issue={issue} question={issue.question} />,
    });
  if (executions.error)
    displayed.push({
      id: "executions-unread",
      role: "bot",
      text: (
        <Alert tone="warning" title={t("conversation.executionsUnreadTitle")}>
          <p>{executions.error}</p>
        </Alert>
      ),
    });
  if (contract?.error)
    displayed.push({
      id: "contract-error",
      role: "bot",
      text: (
        <Alert tone="warning" title={t("shared.stepUnfinished")}>
          <p>{contract.error}</p>
          {!issue.messages?.length ? (
            <Button
              disabled={contract.busy}
              variant="secondary"
              onClick={() => void contract.retryInitial()}
            >
              {t("conversation.retryClarify")}
            </Button>
          ) : null}
          <p>{t("conversation.keptNote")}</p>
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
        contract?.replying ||
        (issue.status === "pending" && issue.contractState === "confirmed")
      }
      activeExecutionId={runId}
      storageKeyPrefix={conversationStoragePrefixes.issue}
      inputLabel={t("conversation.inputLabel")}
      sendLabel={t("conversation.sendLabel")}
      placeholder={
        clarifying
          ? t("conversation.placeholderClarifying")
          : issue.question && issue.status === "blocked"
            ? t("conversation.placeholderAnswer")
            : issue.status === "in_progress"
              ? t("conversation.placeholderWorking")
              : t("conversation.placeholderContinue")
      }
      onSend={send}
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
              ? t("conversation.readOnlyAccepted")
              : t("conversation.readOnlyAbandoned")}{" "}
            {t("conversation.readOnlyFollowUp")}
          </p>
        ) : undefined
      }
    />
  );
}
