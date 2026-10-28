import { useCallback, useMemo, useRef, useState } from "react";
import { CircleAlert, Paperclip } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AgentComposer } from "../ui/agent-composer";
import { Alert } from "../ui/alert";
import { ChatTranscriptStage } from "./chat-transcript-stage";
import { AttachmentList } from "./attachment-list";
import { ImagePreviewOverlay } from "./image-preview-overlay";
import { useChatScrollFollow } from "./use-chat-scroll-follow";
import { useConversationInput } from "./use-conversation-input";
import { ConversationQueue } from "./conversation-queue";
import { withAgentQuestionStates } from "./agent-questions";
import type { ConversationProps, ParsedImageTag } from "./conversation-types";

/** Complete Chat/Issue UI. Hosts provide data and transport callbacks, never input markup. */
export function Conversation(props: ConversationProps) {
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
  const hasDraft = Boolean(input.draft.trim() || props.attachments?.length);
  const actionLabel =
    input.action === "sending"
      ? t("composer.sending")
      : input.action === "stop"
        ? (props.stopLabel ?? t("composer.stop"))
        : (props.sendLabel ?? t("composer.send"));
  return (
    <div className="fdy-chat-conversation">
      <ChatTranscriptStage
        active={turnRunning}
        fileActions={props.fileActions}
        history={props.history}
        onReachHistoryStart={props.onReachHistoryStart}
        messages={messages}
        onAnswerQuestion={props.readOnly ? undefined : onAnswerQuestion}
        threadKey={props.threadKey}
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
      {props.readOnly ? (
        props.readOnly
      ) : (
        <AgentComposer
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
            onSubmit: input.submit,
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
              ? t("composer.sendWhileRunning")
              : actionLabel
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
          className="fdy-chat-composer"
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
          {props.notice}
          <ConversationQueue
            input={input}
            focus={focus}
            onPreview={onPreview}
          />
          {props.disabled && props.disabledReason ? (
            <p className="fdy-chat-composer-blocked" role="status">
              <CircleAlert size={14} aria-hidden="true" />
              {props.disabledReason}
            </p>
          ) : null}
          {props.attachments?.length || props.attachmentUploading ? (
            <div className="fdy-chat-attachment-stage">
              <AttachmentList
                attachments={props.attachments ?? []}
                onPreview={onPreview}
                onRemove={input.sending ? undefined : props.onAttachmentRemove}
                removable={!input.sending}
              />
              {props.attachmentUploading ? (
                <span className="fdy-chat-attachment-uploading">
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
        <ImagePreviewOverlay
          image={preview}
          onClose={() => setPreview(undefined)}
        />
      ) : null}
    </div>
  );
}
