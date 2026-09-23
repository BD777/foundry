import { ArrowRight, Pencil } from "lucide-react";
import { memo, type RefObject } from "react";
import type { ChatAttachment } from "@foundry/protocol";
import { Button } from "../ui/button";
import { Alert } from "../ui/alert";
import { diagnosticSummary } from "../../lib/diagnostic-summary";
import {
  AttachmentList,
  CopyButton,
  MarkdownContent,
  ProcessDisclosure,
  ToolCallItem,
  type ParsedImageTag,
} from "./chat-message-content";
import type { ChatMessageItem } from "./conversation-types";

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

function messagesEqual(left: ChatMessageItem, right: ChatMessageItem): boolean {
  return (
    left === right ||
    (left.id === right.id &&
      left.at === right.at &&
      left.kind === right.kind &&
      left.role === right.role &&
      left.text === right.text &&
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
    message,
    onEditMessage,
    onImagePreview,
  }: {
    message: ChatMessageItem;
    onEditMessage?: (text: string) => void;
    onImagePreview?: (image: ParsedImageTag) => void;
  }) {
    const messageTime = message.at ? new Date(message.at) : undefined;
    const validMessageTime =
      messageTime && !Number.isNaN(messageTime.getTime());
    if (message.kind === "boundary") {
      return (
        <div className="fdy-chat-truncation-boundary">
          <span />
          <strong>{message.text}</strong>
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
          title={message.title ?? "执行失败"}
          details={diagnostic.details}
        >
          <p>{diagnostic.summary}</p>
        </Alert>
      );
    }
    if (message.kind === "process") {
      return (
        <ProcessDisclosure
          items={message.processItems}
          onImagePreview={onImagePreview}
          streaming={message.streaming}
          text={message.text}
          title={message.title ?? "已处理"}
        />
      );
    }
    if (message.kind === "tool") {
      return (
        <ToolCallItem
          streaming={message.streaming}
          text={message.text}
          title={message.title ?? "Context"}
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
            onImagePreview={onImagePreview}
            preserveLists={message.role === "user"}
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
        </div>
        {message.copyText ? (
          <CopyButton always={message.copyAlways} text={message.copyText} />
        ) : null}
        {validMessageTime ? (
          <time
            className="fdy-chat-message-time"
            dateTime={message.at}
            title={messageTime.toLocaleString()}
          >
            {messageTime.toLocaleString(undefined, {
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
              hour12: false,
            })}
          </time>
        ) : null}
        {onEditMessage && message.editable && message.editText ? (
          <Button
            aria-label="Edit message"
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
            <span>
              Keep this thread moving here, or capture it as an issue.
            </span>
            <Button
              onClick={message.onTurnIntoIssue}
              size="sm"
              variant="primary"
            >
              <ArrowRight size={13} />
              Turn into issue
            </Button>
          </div>
        ) : null}
      </article>
    );
  },
  (left, right) =>
    messagesEqual(left.message, right.message) &&
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
