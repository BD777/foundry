import { useCallback, useMemo, useRef, type Ref } from "react";
import { useTranslation } from "react-i18next";
import type { Issue, Run } from "@bd777/foundry-protocol";
import {
  answerIssueQuestion,
  issueEnvironmentAction,
  requestChanges,
  steerIssue,
} from "../../api";
import { IssueQuestionCard } from "./issue-question-card";
import { Conversation } from "../../components/conversation/conversation";
import { conversationStoragePrefixes } from "../../components/conversation/conversation-storage";
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
  const { t } = useTranslation("issueDetail");
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
      attachments?: import("@bd777/foundry-protocol").ChatAttachment[],
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
      // Free text answers the execution's question when one is waiting.
      if (issue.question && issue.status === "blocked") {
        await answerIssueQuestion(issue.id, issue.question.id, text);
        onRefresh(issue.id);
        return true;
      }
      if (contract && issue.contractState !== "confirmed")
        throw new Error(t("conversation.clarifyFirst"));
      await requestChanges(issue.id, text, runId);
      onRefresh(issue.id);
      return true;
    },
    [issue, runId, onRefresh, clarifying, contract, t],
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
      onRefresh(issue.id);
      return true;
    },
    [issue.id, onRefresh, t],
  );
  const stop = useCallback(async () => {
    await issueEnvironmentAction(issue.id, "cancel");
    onRefresh(issue.id);
  }, [issue.id, onRefresh]);
  const terminal = issue.status === "accepted" || issue.status === "abandoned";
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
              onClick={() => void contract.retryReply().catch(() => {})}
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
    else if (!issue.messages?.length)
      displayed.push({
        id: "clarification-welcome",
        role: "bot",
        text: t("conversation.welcome"),
      });
  }
  if (issue.question)
    displayed.push({
      id: `question-${issue.question.id}`,
      role: "bot",
      text: (
        <IssueQuestionCard
          issue={issue}
          question={issue.question}
          onAnswered={() => onRefresh(issue.id)}
        />
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
              onClick={() => void contract.retryInitial().catch(() => {})}
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
              ? t("conversation.readOnlyAccepted")
              : t("conversation.readOnlyAbandoned")}{" "}
            {t("conversation.readOnlyFollowUp")}
          </p>
        ) : undefined
      }
    />
  );
}
