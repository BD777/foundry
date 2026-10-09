import { ArrowRight, Files, Pencil } from "lucide-react";
import { memo, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { ChatAttachment } from "@bd777/foundry-protocol";
import { Button } from "../ui/button";
import { Alert } from "../ui/alert";
import { i18n } from "../../i18n";
import { diagnosticSummary } from "../../lib/diagnostic-summary";
import {
  AttachmentList,
  CopyButton,
  MarkdownContent,
  ProcessDisclosure,
  ToolCallItem,
  type ParsedImageTag,
} from "./chat-message-content";
import type {
  ChatMessageItem,
  ConversationFileActions,
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
      item.detail === other.detail
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
      reference.kind === right[index]!.kind,
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
      left.streaming === right.streaming &&
      attachmentsEqual(left.attachments, right.attachments))
  );
}

export const ChatMessageRow = memo(
  function ChatMessageRow({
    fileActions,
    message,
    onEditMessage,
    onImagePreview,
  }: {
    fileActions?: ConversationFileActions;
    message: ChatMessageItem;
    onEditMessage?: (text: string) => void;
    onImagePreview?: (image: ParsedImageTag) => void;
  }) {
    const { t } = useTranslation("conversation");
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
    if (message.kind === "failure") {
      const diagnostic =
        typeof message.text === "string"
          ? diagnosticSummary(message.text)
          : { summary: message.text, details: undefined };
      return (
        <Alert
          tone={message.recoverable ? "warning" : "error"}
          title={displayTitle(message.title) ?? t("message.failed")}
          details={diagnostic.details}
        >
          <p>{diagnostic.summary}</p>
        </Alert>
      );
    }
    if (message.kind === "process") {
      return (
        <ProcessDisclosure
          durationMs={message.durationMs}
          items={message.processItems}
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
        <div className="fdy-chat-message-copy fdy-markdown">
          <MarkdownContent
            fileReferences={message.fileReferences}
            onImagePreview={onImagePreview}
            onOpenFileReference={fileActions?.open}
            typedText={message.role === "user"}
            streaming={message.streaming}
          >
            {message.text}
          </MarkdownContent>
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
          <CopyButton always={message.copyAlways} text={message.copyText} />
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
