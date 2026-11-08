import { ArrowRight, Files, Hourglass, Pencil } from "lucide-react";
import { memo, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { ChatAttachment } from "@bd777/foundry-protocol";
import { Button } from "../ui/button";
import { Alert } from "../ui/alert";
import { i18n } from "../../i18n";
import { cn } from "../../lib/cn";
import { diagnosticSummary } from "../../lib/diagnostic-summary";
import { CopyButton } from "../ui/copy-button";
import { CompactionDivider } from "./compaction-divider";
import { AttachmentList } from "./attachment-list";
import {
  AgentQuestionCard,
  AgentQuestionReplyView,
} from "./agent-question-card";
import { MarkdownContent } from "./markdown-content";
import { ProcessDisclosure, ToolCallItem } from "./process-disclosure";
import { SteerStatus } from "./steer-status";
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
      left.steer?.state === right.steer?.state &&
      left.steer?.readAt === right.steer?.readAt &&
      left.steer?.tool?.name === right.steer?.tool?.name &&
      left.steer?.tool?.startedAt === right.steer?.tool?.startedAt &&
      left.steer?.moreTools === right.steer?.moreTools &&
      Boolean(left.onStopSteerBlocker) === Boolean(right.onStopSteerBlocker) &&
      left.liveActivity?.callId === right.liveActivity?.callId &&
      left.liveActivity?.title === right.liveActivity?.title &&
      left.liveActivity?.detail === right.liveActivity?.detail &&
      left.liveActivity?.startedAt === right.liveActivity?.startedAt &&
      left.sentBy?.label === right.sentBy?.label &&
      Boolean(left.sentBy?.onOpen) === Boolean(right.sentBy?.onOpen) &&
      attachmentsEqual(left.attachments, right.attachments))
  );
}

/**
 * A message's own action (copy, edit): a quiet round button under it that
 * appears when the message is pointed at or focused, or sits in the flow
 * where the message always offers it.
 */
function messageActionClass(always: boolean): string {
  return cn(
    "size-7 rounded-full bg-transparent text-ink-faint transition-[background-color,color,opacity] duration-150 hover:bg-transparent hover:text-ink focus-visible:opacity-100 data-[copied=true]:text-success-text",
    always
      ? "mt-1.5 inline-flex align-top opacity-100"
      : "absolute top-[calc(100%+2px)] z-2 opacity-0 group-hover/card:opacity-100 no-hover:opacity-100",
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
    <p className="mb-1 overflow-hidden text-xs leading-normal text-ellipsis whitespace-nowrap text-ink-faint">
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
        <strong className="font-medium text-ink-muted">{sentBy.label}</strong>
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
    const user = message.role === "user";
    const messageTime = message.at ? new Date(message.at) : undefined;
    const validMessageTime =
      messageTime && !Number.isNaN(messageTime.getTime());
    // The chip appears once the turn has settled and the host can show it.
    const turnFiles =
      fileActions && !message.streaming && message.turnFiles?.count
        ? message.turnFiles
        : undefined;
    if (message.kind === "boundary" && message.compaction) {
      return (
        <CompactionDivider at={message.at} compaction={message.compaction} />
      );
    }
    if (message.kind === "boundary") {
      return (
        <div className="my-1 grid w-full grid-cols-[minmax(36px,1fr)_auto_minmax(36px,1fr)] items-center gap-3 text-ink-faint">
          <span className="h-px bg-line" />
          <strong className="max-w-[min(560px,100%)] text-center text-xs leading-[1.45] font-[650] text-ink-faint">
            {displayTitle(message.text)}
          </strong>
          <span className="h-px bg-line" />
        </div>
      );
    }
    if (message.kind === "waiting") {
      return (
        <div
          className="flex max-w-full items-start gap-2 py-[5px] text-sm leading-[1.45] text-ink-muted"
          role="status"
        >
          <Hourglass
            aria-hidden="true"
            className="mt-0.5 flex-none text-warning-text"
            size={15}
          />
          <span className="grid min-w-0 gap-0.5">
            <strong className="font-semibold text-ink">{message.title}</strong>
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
          <div className="grid gap-2">
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
          liveActivity={message.liveActivity}
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
    const attachments = message.attachments?.length ? (
      <AttachmentList
        align={user ? "end" : "start"}
        attachments={message.attachments}
        onPreview={onImagePreview}
      />
    ) : null;
    // A sent message's attachments sit above its bubble, as in the major chat
    // apps; a message of attachments alone has no empty bubble.
    const hasText =
      typeof message.text === "string"
        ? message.text.trim() !== ""
        : message.text != null;
    const bubble =
      hasText ||
      message.steer ||
      message.origin ||
      message.sentBy ||
      message.idea;
    const attachmentsAlone = user && attachments && !bubble;
    // Time and usage, under the bubble on hover (or the tiles of a message
    // of attachments alone).
    const meta =
      validMessageTime || message.usage ? (
        <span
          className={cn(
            "inline-flex items-center gap-x-0.5 text-2xs leading-7 whitespace-nowrap text-ink-faint transition-opacity duration-150",
            message.copyAlways
              ? "mt-1.5 ml-1 flex-wrap align-top"
              : [
                  "absolute top-[calc(100%+2px)] max-w-[calc(100%-25px)] opacity-0 group-hover/card:opacity-100 group-focus-within/card:opacity-100",
                  attachmentsAlone
                    ? "right-0"
                    : user
                      ? "right-14"
                      : "left-[25px]",
                ],
          )}
        >
          {validMessageTime ? (
            <time
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
      ) : null;
    const card = (
      <article
        className={cn(
          "fdy-chat-message-card group/card relative block min-w-0",
          user
            ? "ml-auto w-fit max-w-[80%] rounded-xl rounded-br-xs bg-control-ghost-hover bg-clip-padding px-3.5 py-2.5 max-[860px]:max-w-full"
            : "mb-1 max-w-full",
        )}
        data-role={message.role}
        data-copy-always={message.copyAlways ? "true" : "false"}
        data-streaming={message.streaming ? "true" : "false"}
      >
        {message.sentBy ? <MessageSender sentBy={message.sentBy} /> : null}
        <div
          className={cn(
            "fdy-chat-message-copy relative m-0 text-md text-ink [overflow-wrap:anywhere] [text-wrap:pretty]",
            user ? "leading-normal" : "leading-[1.65]",
            !user && message.streaming && "max-w-full [contain:paint]",
          )}
        >
          {message.questions?.length &&
          message.questionItemId &&
          message.questionState ? (
            <AgentQuestionCard
              active={active}
              answers={message.questionAnswers}
              itemId={message.questionItemId}
              onAnswer={onAnswerQuestion}
              relayed={message.questionDelivery === "next_turn"}
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
          {user ? null : attachments}
          {message.origin ? (
            <span className="mt-1 block text-2xs text-ink-faint">
              {message.origin}
            </span>
          ) : null}
          {message.steer ? (
            <SteerStatus
              onStop={message.onStopSteerBlocker}
              steer={message.steer}
            />
          ) : null}
          {turnFiles ? (
            <Button
              className="mt-2.5 w-fit font-semibold text-ink-muted"
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
            className={cn(
              messageActionClass(Boolean(message.copyAlways)),
              !message.copyAlways && (user ? "right-[-4px]" : "left-[-7px]"),
            )}
            copiedLabel={t("common:actions.copied")}
            data-always={message.copyAlways ? "true" : "false"}
            label={t("message.copyMessage")}
            showCheck={false}
            text={message.copyText}
          />
        ) : null}
        {meta}
        {onEditMessage && message.editable && message.editText ? (
          <Button
            aria-label={t("message.editMessage")}
            className={cn(
              messageActionClass(Boolean(message.copyAlways)),
              !message.copyAlways && "right-6",
            )}
            onClick={() => onEditMessage(message.editText ?? "")}
            size="icon"
            variant="ghost"
          >
            <Pencil size={14} />
          </Button>
        ) : null}
        {message.idea ? (
          <Alert
            actions={
              <Button
                onClick={message.onTurnIntoIssue}
                size="sm"
                variant="primary"
              >
                <ArrowRight size={13} />
                {t("message.turnIntoIssue")}
              </Button>
            }
            className="mt-3"
            size="compact"
            title={t("message.idea")}
          />
        ) : null}
      </article>
    );
    if (!user || !attachments) return card;
    return bubble ? (
      <div className="grid min-w-0 justify-items-end gap-2">
        {attachments}
        {card}
      </div>
    ) : (
      <div className="group/card relative grid min-w-0 justify-items-end">
        {attachments}
        {meta}
      </div>
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
  className,
  contentRef,
  messages,
  onEditMessage,
  onImagePreview,
}: {
  /** Class of the list, e.g. to let it fill a side panel instead of a column. */
  className?: string;
  contentRef?: RefObject<HTMLDivElement | null>;
  messages: ChatMessageItem[];
  onEditMessage?: (text: string) => void;
  onImagePreview?: (image: ParsedImageTag) => void;
}) {
  return (
    <div
      className={cn(
        "fdy-chat-message-wrap mx-auto flex w-full max-w-[720px] min-w-0 flex-col gap-[22px] [&>*]:[overflow-anchor:none]",
        className,
      )}
      ref={contentRef}
    >
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
