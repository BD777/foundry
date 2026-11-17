import { useCallback, useMemo, useRef, useState } from "react";
import { Paperclip } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AgentComposer } from "../agent-runtime/agent-composer";
import { Alert } from "../ui/alert";
import { ChatTranscriptStage } from "./chat-transcript-stage";
import { AnnotationChip } from "./annotation-chip";
import {
  AnnotationReferenceContext,
  type AnnotationReferenceValue,
} from "./annotation-reference";
import type { AnswerSelectionDraft } from "./answer-annotations";
import type { ConversationAnnotation } from "./annotations";

const NO_SENT_ANNOTATIONS: readonly ConversationAnnotation[] = [];
import type { ChatMessageItem } from "./conversation-types";
import { AttachmentList } from "./attachment-list";
import { ImagePreview } from "./local-image";
import { useChatScrollFollow } from "./use-chat-scroll-follow";
import { useConversationInput } from "./use-conversation-input";
import { ConversationQueue } from "./conversation-queue";
import { withAgentQuestionStates } from "./agent-questions";
import type {
  ConversationDelivery,
  ConversationProps,
  ParsedImageTag,
} from "./conversation-types";
import { deliveryForModifier, deliveryOptions } from "./delivery-choices";
import {
  composerColumn,
  conversationRoot,
  turnRailVars,
} from "./conversation-layout";
import { cn } from "../../lib/cn";

/** A message a link opened the conversation at (see ChatTranscriptStage). */
export interface ConversationFocusProps {
  focusMessageId?: string;
  onMessageFocused?: () => void;
}

/** Complete Chat/Issue UI. Hosts provide data and transport callbacks, never input markup. */
export function Conversation(
  props: ConversationProps & ConversationFocusProps,
) {
  const { t } = useTranslation("conversation");
  const scroll = useChatScrollFollow(props.threadKey);
  const input = useConversationInput(props, scroll.followLatest);
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const files = useRef<HTMLInputElement | null>(null);
  const [preview, setPreview] = useState<ParsedImageTag>();
  const [dragActive, setDragActive] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const onPreview = props.onImagePreview ?? setPreview;
  // Questions read their state from the transcript: a reply, what followed.
  const turnRunning = Boolean(props.active);
  const messages = useMemo(
    () => withAgentQuestionStates(props.messages, turnRunning),
    [props.messages, turnRunning],
  );
  const answerQuestion = input.answerQuestion;
  // Annotations need a live composer: not on read-only or disabled conversations.
  const annotationsEnabled = !props.readOnly && !props.disabled;
  const annotationStore = input.annotations;
  const annotationStoreRef = useRef(annotationStore);
  annotationStoreRef.current = annotationStore;
  const annotationList = annotationStore.annotations;
  const answerAnnotations = useMemo(
    () => ({
      annotations: annotationList,
      enabled: annotationsEnabled,
      onAdd: (
        answer: ChatMessageItem,
        draft: AnswerSelectionDraft,
        turnNumber: number,
      ) => {
        const annotation: ConversationAnnotation = {
          id: crypto.randomUUID(),
          sourceEventId: answer.id,
          ...(turnNumber > 0 ? { turnNumber } : {}),
          ...(answer.at ? { messageAt: answer.at } : {}),
          selectedText: draft.selectedText,
          anchor: draft.anchor,
          ...(draft.comment ? { comment: draft.comment } : {}),
        };
        annotationStoreRef.current.add(annotation);
      },
      onUpdate: (id: string, comment: string) =>
        annotationStoreRef.current.update(id, { comment }),
      onRemove: (id: string) => annotationStoreRef.current.remove(id),
    }),
    [annotationList, annotationsEnabled],
  );
  // Sent annotations, by id and by the answer they are from.
  const sentAnnotations = useMemo(() => {
    const byId = new Map<string, ConversationAnnotation>();
    const byAnswer = new Map<string, ConversationAnnotation[]>();
    for (const message of messages)
      for (const annotation of message.annotations ?? []) {
        byId.set(annotation.id, annotation);
        byAnswer.set(annotation.sourceEventId, [
          ...(byAnswer.get(annotation.sourceEventId) ?? []),
          annotation,
        ]);
      }
    return { byAnswer, byId };
  }, [messages]);
  const [sourceFocusId, setSourceFocusId] = useState<string>();
  const referenceValue = useMemo<AnnotationReferenceValue>(
    () => ({
      lookup: (id) => sentAnnotations.byId.get(id),
      openSource: (messageId) => setSourceFocusId(messageId),
      sentFor: (messageId) =>
        sentAnnotations.byAnswer.get(messageId) ?? NO_SENT_ANNOTATIONS,
    }),
    [sentAnnotations],
  );
  const latestAnswer = useRef(answerQuestion);
  latestAnswer.current = answerQuestion;
  const onAnswerQuestion = useCallback(
    (text: string, key: string) => latestAnswer.current(text, key),
    [],
  );
  const focus = () => requestAnimationFrame(() => textarea.current?.focus());
  const addFiles = (list: FileList | File[] | null | undefined) => {
    if (input.sending) return;
    const selected = Array.from(list ?? []).filter((file) => file.size > 0);
    if (selected.length) props.onAttachmentsAdd?.(selected);
  };
  const selectable =
    props.composer.mode === "selectable" ? props.composer : undefined;
  const hasDraft = Boolean(
    input.draft.trim() ||
    props.attachments?.length ||
    input.annotations.annotations.length,
  );
  const actionLabel =
    input.action === "sending"
      ? t("composer.sending")
      : input.action === "stop"
        ? (props.stopLabel ?? t("composer.stop"))
        : (props.sendLabel ?? t("composer.send"));
  return (
    <div className={cn("fdy-chat-conversation", conversationRoot)}>
      <AnnotationReferenceContext.Provider value={referenceValue}>
        <ChatTranscriptStage
          active={turnRunning}
          answerAnnotations={answerAnnotations}
          fileActions={props.fileActions}
          history={props.history}
          onReachHistoryStart={props.onReachHistoryStart}
          messages={messages}
          onlyMine={props.onlyMine}
          onHiddenTurnsChange={props.onHiddenTurnsChange}
          onAnswerQuestion={props.readOnly ? undefined : onAnswerQuestion}
          threadKey={props.threadKey}
          focusMessageId={sourceFocusId ?? props.focusMessageId}
          onMessageFocused={() => {
            if (sourceFocusId) setSourceFocusId(undefined);
            else props.onMessageFocused?.();
          }}
          scrollController={scroll}
          showScrollToLatest={scroll.showScrollToLatest && !controlsOpen}
          onEditMessage={
            props.readOnly
              ? undefined
              : (text) => {
                  input.updateDraft(text);
                  focus();
                }
          }
          onImagePreview={onPreview}
        />
      </AnnotationReferenceContext.Provider>
      {props.readOnly ? (
        <div
          className={cn(
            "fdy-chat-read-only mb-5 box-border",
            turnRailVars,
            composerColumn,
          )}
        >
          {props.readOnly}
        </div>
      ) : (
        <AgentComposer
          pillStyle="flat"
          slashItems={selectable?.slashItems}
          input={{
            "aria-label": props.inputLabel ?? t("composer.inputLabel"),
            ref: (node) => {
              textarea.current = node;
              if (typeof props.inputRef === "function") props.inputRef(node);
              else if (props.inputRef) props.inputRef.current = node;
            },
            value: input.draft,
            readOnly: input.sending,
            "aria-busy": input.sending,
            onChange: (event) => input.updateDraft(event.target.value),
            onInput: (event) => input.updateDraft(event.currentTarget.value),
            // During a running turn the modifier picks when the message
            // enters it (DEV-082); otherwise Enter just sends.
            onSubmit: (modifier) =>
              input.submit(
                turnRunning && input.deliveryChoices
                  ? deliveryForModifier(modifier)
                  : undefined,
              ),
            submitDisabled: input.unavailable || !hasDraft || input.sending,
            onPaste: props.onAttachmentsAdd
              ? (event) => {
                  if (event.clipboardData.files.length) {
                    event.preventDefault();
                    addFiles(event.clipboardData.files);
                  }
                }
              : undefined,
            placeholder: props.placeholder ?? t("composer.placeholder"),
          }}
          agentOptions={selectable?.agentOptions}
          agentPickerFooter={selectable?.agentPickerFooter}
          agentPickerActions={selectable?.agentPickerActions}
          agentValue={selectable?.agentValue}
          onAgentChange={selectable?.onAgentChange}
          agentLabel={t("composer.agentLabel")}
          runtimeControls={
            selectable
              ? {
                  ...selectable.runtimeControls,
                  onMenuOpenChange: setControlsOpen,
                }
              : undefined
          }
          fixedRuntime={
            props.composer.mode === "fixed" ? props.composer : undefined
          }
          hideAgent={props.composer.mode === "plain"}
          fileInput={
            props.onAttachmentsAdd
              ? {
                  ref: files,
                  multiple: true,
                  onChange: (event) => {
                    addFiles(event.currentTarget.files);
                    event.currentTarget.value = "";
                  },
                }
              : undefined
          }
          onAttach={
            props.onAttachmentsAdd ? () => files.current?.click() : undefined
          }
          controlsDisabled={input.sending}
          actionState={input.action}
          actionLabel={actionLabel}
          actionHint={
            input.action === "send" && props.active
              ? input.deliveryChoices
                ? t("delivery.sendNext")
                : t("composer.sendWhileRunning")
              : actionLabel
          }
          actionMenu={
            input.deliveryChoices
              ? {
                  label: t("delivery.menuLabel"),
                  heading: !turnRunning
                    ? t("delivery.headingIdle")
                    : hasDraft
                      ? t("delivery.headingRunning")
                      : t("delivery.headingEmpty"),
                  options: deliveryOptions(t, input.runtime, {
                    disabled:
                      !turnRunning ||
                      !hasDraft ||
                      input.unavailable ||
                      input.sending,
                  }),
                  onChoose: (value) =>
                    input.submit(value as ConversationDelivery),
                }
              : undefined
          }
          actionDisabled={
            input.action === "sending" ||
            (input.action === "stop"
              ? !props.onStop || !props.active || input.pending
              : input.unavailable || !hasDraft)
          }
          onAction={() => {
            if (input.action === "stop") void input.stop();
            else if (input.action === "send") input.submit();
          }}
          className={cn(
            "fdy-chat-composer relative z-2 -mt-4 mb-5 shadow-prompt focus-within:shadow-prompt-focus data-[drag-active=true]:bg-accent-soft data-[drag-active=true]:shadow-prompt-drag",
            turnRailVars,
            composerColumn,
          )}
          data-drag-active={dragActive ? "true" : "false"}
          onDragEnter={(event) => {
            if (
              props.onAttachmentsAdd &&
              event.dataTransfer.types.includes("Files")
            ) {
              event.preventDefault();
              setDragActive(true);
            }
          }}
          onDragLeave={(event) => {
            if (
              !event.currentTarget.contains(event.relatedTarget as Node | null)
            )
              setDragActive(false);
          }}
          onDragOver={(event) => {
            if (
              props.onAttachmentsAdd &&
              event.dataTransfer.types.includes("Files")
            )
              event.preventDefault();
          }}
          onDrop={(event) => {
            if (props.onAttachmentsAdd && event.dataTransfer.files.length) {
              event.preventDefault();
              setDragActive(false);
              addFiles(event.dataTransfer.files);
            }
          }}
        >
          {props.attention}
          {props.notice}
          <ConversationQueue
            input={input}
            focus={focus}
            onPreview={onPreview}
          />
          {props.disabled && props.disabledReason ? (
            <Alert
              className="mb-1.5"
              size="compact"
              title={props.disabledReason}
              tone="warning"
            />
          ) : null}
          {annotationsEnabled && annotationList.length ? (
            <div className="flex min-w-0 flex-wrap items-start gap-2 pt-0.5 pb-[9px]">
              <AnnotationChip
                annotations={annotationList}
                onClear={() => annotationStore.clear()}
                onRemove={(id) => annotationStore.remove(id)}
                onUpdate={(id, comment) =>
                  annotationStore.update(id, { comment })
                }
              />
            </div>
          ) : null}
          {props.attachments?.length || props.attachmentUploading ? (
            <div className="flex min-w-0 flex-wrap items-start gap-2 pt-0.5 pb-[9px]">
              <AttachmentList
                attachments={props.attachments ?? []}
                onPreview={onPreview}
                onRemove={input.sending ? undefined : props.onAttachmentRemove}
                removable={!input.sending}
              />
              {props.attachmentUploading ? (
                <span className="inline-flex h-8 items-center gap-1.5 rounded-full bg-panel-soft px-2.5 text-xs font-[650] text-ink-muted">
                  <Paperclip size={14} />
                  {t("composer.uploading")}
                </span>
              ) : null}
            </div>
          ) : null}
          {input.error ? (
            <Alert tone="error" title={t("composer.requestFailed")}>
              {input.error}
            </Alert>
          ) : null}
        </AgentComposer>
      )}
      {preview ? (
        <ImagePreview image={preview} onClose={() => setPreview(undefined)} />
      ) : null}
    </div>
  );
}
