import { ArrowRight, Files, Hourglass, Pencil } from "lucide-react";
import { memo, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { ChatAttachment } from "@bd777/foundry-protocol";
import { Button } from "../ui/button";
import { Alert } from "../ui/alert";
import { i18n } from "../../i18n";
import { diagnosticSummary } from "../../lib/diagnostic-summary";
import { CopyButton } from "../ui/copy-button";
import { AttachmentList } from "./attachment-list";
import {
  AgentQuestionCard,
  AgentQuestionReplyView,
} from "./agent-question-card";
import { MarkdownContent } from "./markdown-content";
import { ProcessDisclosure, ToolCallItem } from "./process-disclosure";
import type {
  ChatMessageItem,
  ConversationFileActions,
  ParsedImageTag,
  StepUsage,
} from "./conversation-types";
import { displayProcessLabel } from "../../lib/process-labels";
import { TurnUsage } from "./turn-usage";

/** Worker-recorded labels in the viewer's language; other content as is. */
const displayTitle = (title: ReactNode) =>
  typeof title === "string" ? displayProcessLabel(title) : title;

function attachmentsEqual(
  left: ChatAttachment[] | undefined,
  right: ChatAttachment[] | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  return left.every((attachment, index) => {
    const candidate = right[index];
    return (
      candidate !== undefined &&
      attachment.id === candidate.id &&
      attachment.kind === candidate.kind &&
      attachment.name === candidate.name &&
      attachment.path === candidate.path &&
      attachment.size === candidate.size
    );
  });
}

function processItemsEqual(
  left: ChatMessageItem["processItems"],
  right: ChatMessageItem["processItems"],
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((item, index) => {
    const other = right[index]!;
    return (
      item.id === other.id &&
      item.kind === other.kind &&
      item.callId === other.callId &&
      item.status === other.status &&
      item.title === other.title &&
      item.detail === other.detail &&
      item.frames?.length === other.frames?.length &&
      item.frames?.at(-1)?.id === other.frames?.at(-1)?.id
    );
  });
}

function stepUsageEqual(left?: StepUsage, right?: StepUsage): boolean {
  return (
    left === right ||
    (!!left &&
      !!right &&
      left.requests === right.requests &&
      left.inputTokens === right.inputTokens &&
      left.cacheReadTokens === right.cacheReadTokens &&
      left.outputTokens === right.outputTokens)
  );
}

function fileReferencesEqual(
  left: ChatMessageItem["fileReferences"],
  right: ChatMessageItem["fileReferences"],
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every(
    (reference, index) =>
      reference.text === right[index]!.text &&
      reference.path === right[index]!.path &&
      reference.kind === right[index]!.kind &&
      Boolean(reference.pending) === Boolean(right[index]!.pending) &&
      reference.sessionId === right[index]!.sessionId,
  );
}

function messagesEqual(left: ChatMessageItem, right: ChatMessageItem): boolean {
  return (
    left === right ||
    (left.id === right.id &&
      left.at === right.at &&
      left.kind === right.kind &&
      left.role === right.role &&
      left.text === right.text &&
      left.usage === right.usage &&
      fileReferencesEqual(left.fileReferences, right.fileReferences) &&
      left.turnFiles?.turnId === right.turnFiles?.turnId &&
      left.turnFiles?.count === right.turnFiles?.count &&
      left.durationMs === right.durationMs &&
      left.startedAt === right.startedAt &&
      stepUsageEqual(left.stepUsage, right.stepUsage) &&
      processItemsEqual(left.processItems, right.processItems) &&
      left.title === right.title &&
      left.copyText === right.copyText &&
      left.copyAlways === right.copyAlways &&
      left.editable === right.editable &&
      left.editText === right.editText &&
      left.idea === right.idea &&
      left.recoverable === right.recoverable &&
      left.failureDiagnostic?.location === right.failureDiagnostic?.location &&
      left.failureDiagnostic?.guidance === right.failureDiagnostic?.guidance &&
      left.failureDiagnostic?.observation ===
        right.failureDiagnostic?.observation &&
      left.failureDiagnostic?.details === right.failureDiagnostic?.details &&
      left.streaming === right.streaming &&
      left.questionState === right.questionState &&
      left.questionItemId === right.questionItemId &&
      left.questions?.length === right.questions?.length &&
      left.questionAnswers?.join("\n") === right.questionAnswers?.join("\n") &&
      left.questionReply?.length === right.questionReply?.length &&
      left.sentBy?.sessionId === right.sentBy?.sessionId &&
      left.sentBy?.label === right.sentBy?.label &&
      Boolean(left.sentBy?.onOpen) === Boolean(right.sentBy?.onOpen) &&
      attachmentsEqual(left.attachments, right.attachments))
  );
}

/** "From <session>" above a message another session sent. */
function MessageSender({
  sentBy,
}: {
  sentBy: NonNullable<ChatMessageItem["sentBy"]>;
}) {
  const { t } = useTranslation("conversation");
  return (
    <p className="fdy-chat-message-sender">
      <span>{t("message.sentBy")}</span>{" "}
      {sentBy.onOpen ? (
        <Button
          onClick={sentBy.onOpen}
          size="inline"
          title={t("message.openSender", { title: sentBy.label })}
          variant="link"
        >
          {sentBy.label}
        </Button>
      ) : (
        <strong>{sentBy.label}</strong>
      )}
    </p>
  );
}

export const ChatMessageRow = memo(
  function ChatMessageRow({
    active = false,
    fileActions,
    message,
    onAnswerQuestion,
    onEditMessage,
    onImagePreview,
  }: {
    /** A turn runs now: an answer to a question goes into it. */
    active?: boolean;
    fileActions?: ConversationFileActions;
    message: ChatMessageItem;
    onAnswerQuestion?: (
      text: string,
      key: string,
    ) => Promise<string | undefined>;
    onEditMessage?: (text: string) => void;
    onImagePreview?: (image: ParsedImageTag) => void;
  }) {
    const { t } = useTranslation(["conversation", "common"]);
    const messageTime = message.at ? new Date(message.at) : undefined;
    const validMessageTime =
      messageTime && !Number.isNaN(messageTime.getTime());
    // The chip appears once the turn has settled and the host can show it.
    const turnFiles =
      fileActions && !message.streaming && message.turnFiles?.count
        ? message.turnFiles
        : undefined;
    if (message.kind === "boundary") {
      return (
        <div className="fdy-chat-truncation-boundary">
          <span />
          <strong>{displayTitle(message.text)}</strong>
          <span />
        </div>
      );
    }
    if (message.kind === "waiting") {
      return (
        <div className="fdy-chat-waiting" role="status">
          <Hourglass aria-hidden="true" size={15} />
          <span className="fdy-chat-waiting-copy">
            <strong>{message.title}</strong>
            {message.text ? <span>{message.text}</span> : null}
          </span>
        </div>
      );
    }
    if (message.kind === "failure") {
      const diagnostic =
        typeof message.text === "string"
          ? diagnosticSummary(message.text)
          : { summary: message.text, details: undefined };
      return (
        <Alert
          tone={message.recoverable ? "warning" : "error"}
          title={displayTitle(message.title) ?? t("message.failed")}
          details={message.failureDiagnostic?.details ?? diagnostic.details}
        >
          <div className="fdy-chat-failure-copy">
            {message.failureDiagnostic?.location ? (
              <p>{message.failureDiagnostic.location}</p>
            ) : null}
            <p>{diagnostic.summary}</p>
            {message.failureDiagnostic?.observation ? (
              <p>{message.failureDiagnostic.observation}</p>
            ) : null}
            {message.failureDiagnostic ? (
              <p>{message.failureDiagnostic.guidance}</p>
            ) : null}
          </div>
        </Alert>
      );
    }
    if (message.kind === "process") {
      return (
        <ProcessDisclosure
          durationMs={message.durationMs}
          items={message.processItems}
          onOpenScreen={fileActions?.openScreen}
          startedAt={message.startedAt}
          stepUsage={message.stepUsage}
          onImagePreview={onImagePreview}
          streaming={message.streaming}
          text={message.text}
          title={message.title ?? t("process.processed")}
        />
      );
    }
    if (message.kind === "tool") {
      return (
        <ToolCallItem
          streaming={message.streaming}
          text={message.text}
          title={displayTitle(message.title) ?? t("message.context")}
        />
      );
    }
    return (
      <article
        className="fdy-chat-message-card"
        data-role={message.role}
        data-copy-always={message.copyAlways ? "true" : "false"}
        data-streaming={message.streaming ? "true" : "false"}
      >
        {message.sentBy ? <MessageSender sentBy={message.sentBy} /> : null}
        <div className="fdy-chat-message-copy fdy-markdown">
          {message.questions?.length &&
          message.questionItemId &&
          message.questionState ? (
            <AgentQuestionCard
              active={active}
              answers={message.questionAnswers}
              itemId={message.questionItemId}
              onAnswer={onAnswerQuestion}
              questions={message.questions}
              state={message.questionState}
            />
          ) : message.questionReply?.length ? (
            <AgentQuestionReplyView replies={message.questionReply} />
          ) : (
            <MarkdownContent
              fileReferences={message.fileReferences}
              // Only answers link the workspace paths they name.
              deviceFiles={message.role !== "user" && fileActions?.deviceFiles}
              fileRoot={message.role === "user" ? undefined : fileActions?.root}
              onImagePreview={onImagePreview}
              onOpenFileReference={fileActions?.open}
              typedText={message.role === "user"}
              streaming={message.streaming}
            >
              {message.text}
            </MarkdownContent>
          )}
          {message.attachments && message.attachments.length > 0 ? (
            <AttachmentList
              attachments={message.attachments}
              onPreview={onImagePreview}
            />
          ) : null}
          {message.origin ? (
            <span className="fdy-chat-message-origin">{message.origin}</span>
          ) : null}
          {turnFiles ? (
            <Button
              className="fdy-chat-turn-files"
              onClick={() => fileActions?.showTurn(turnFiles.turnId)}
              size="sm"
              title={t("message.showTurnFiles")}
              variant="secondary"
            >
              <Files aria-hidden="true" size={13} />
              {t("message.turnFiles", { count: turnFiles.count })}
            </Button>
          ) : null}
        </div>
        {message.copyText ? (
          <CopyButton
            className="fdy-chat-copy-button"
            copiedLabel={t("common:actions.copied")}
            data-always={message.copyAlways ? "true" : "false"}
            label={t("message.copyMessage")}
            showCheck={false}
            text={message.copyText}
          />
        ) : null}
        {validMessageTime || message.usage ? (
          <span className="fdy-chat-message-stamp">
            {validMessageTime ? (
              <time
                className="fdy-chat-message-time"
                dateTime={message.at}
                title={messageTime.toLocaleString(i18n.language)}
              >
                {messageTime.toLocaleString(i18n.language, {
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                  hour12: false,
                })}
              </time>
            ) : null}
            {message.usage && !message.streaming ? (
              <TurnUsage usage={message.usage} />
            ) : null}
          </span>
        ) : null}
        {onEditMessage && message.editable && message.editText ? (
          <Button
            aria-label={t("message.editMessage")}
            className="fdy-chat-copy-button fdy-chat-edit-button"
            onClick={() => onEditMessage(message.editText ?? "")}
            size="icon"
            variant="ghost"
          >
            <Pencil size={14} />
          </Button>
        ) : null}
        {message.idea ? (
          <div className="fdy-chat-issue-draft">
            <span>{t("message.ideaHint")}</span>
            <Button
              onClick={message.onTurnIntoIssue}
              size="sm"
              variant="primary"
            >
              <ArrowRight size={13} />
              {t("message.turnIntoIssue")}
            </Button>
          </div>
        ) : null}
      </article>
    );
  },
  (left, right) =>
    messagesEqual(left.message, right.message) &&
    left.active === right.active &&
    left.onAnswerQuestion === right.onAnswerQuestion &&
    left.fileActions === right.fileActions &&
    left.onEditMessage === right.onEditMessage &&
    left.onImagePreview === right.onImagePreview,
);

export const ChatMessageList = memo(function ChatMessageList({
  contentRef,
  messages,
  onEditMessage,
  onImagePreview,
}: {
  contentRef?: RefObject<HTMLDivElement | null>;
  messages: ChatMessageItem[];
  onEditMessage?: (text: string) => void;
  onImagePreview?: (image: ParsedImageTag) => void;
}) {
  return (
    <div className="fdy-chat-message-wrap" ref={contentRef}>
      {messages.map((message) => (
        <ChatMessageRow
          key={message.id}
          message={message}
          onEditMessage={onEditMessage}
          onImagePreview={onImagePreview}
        />
      ))}
    </div>
  );
});
