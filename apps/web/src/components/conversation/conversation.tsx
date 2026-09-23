import { useRef, useState } from "react";
import { Paperclip } from "lucide-react";
import { AgentComposer } from "../ui/agent-composer";
import { Alert } from "../ui/alert";
import { ChatTranscriptStage } from "./chat-transcript-stage";
import {
  AttachmentList,
  ImagePreviewOverlay,
  type ParsedImageTag,
} from "./chat-message-content";
import { useChatScrollFollow } from "./use-chat-scroll-follow";
import { useConversationInput } from "./use-conversation-input";
import { ConversationQueue } from "./conversation-queue";
import type { ConversationProps } from "./conversation-types";

/** Complete Chat/Issue UI. Hosts provide data and transport callbacks, never input markup. */
export function Conversation(props: ConversationProps) {
  const scroll = useChatScrollFollow(props.threadKey);
  const input = useConversationInput(props, scroll.followLatest);
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const files = useRef<HTMLInputElement | null>(null);
  const [preview, setPreview] = useState<ParsedImageTag>();
  const [dragActive, setDragActive] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const onPreview = props.onImagePreview ?? setPreview;
  const focus = () => requestAnimationFrame(() => textarea.current?.focus());
  const addFiles = (list: FileList | File[] | null | undefined) => {
    const selected = Array.from(list ?? []).filter((file) => file.size > 0);
    if (selected.length) props.onAttachmentsAdd?.(selected);
  };
  const selectable =
    props.composer.mode === "selectable" ? props.composer : undefined;
  const hasDraft = Boolean(input.draft.trim() || props.attachments?.length);
  return (
    <div className="fdy-chat-conversation">
      <ChatTranscriptStage
        messages={props.messages}
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
            "aria-label": props.inputLabel ?? "Chat input",
            ref: (node) => {
              textarea.current = node;
              if (typeof props.inputRef === "function") props.inputRef(node);
              else if (props.inputRef) props.inputRef.current = node;
            },
            value: input.draft,
            onChange: (event) => input.updateDraft(event.target.value),
            onInput: (event) => input.updateDraft(event.currentTarget.value),
            onSubmit: input.submit,
            submitDisabled: input.unavailable || !hasDraft,
            onPaste: props.onAttachmentsAdd
              ? (event) => {
                  if (event.clipboardData.files.length) {
                    event.preventDefault();
                    addFiles(event.clipboardData.files);
                  }
                }
              : undefined,
            placeholder:
              props.placeholder ??
              "Message Codex or Claude in this workspace...",
          }}
          agentOptions={selectable?.agentOptions}
          agentPickerFooter={selectable?.agentPickerFooter}
          agentValue={selectable?.agentValue}
          onAgentChange={selectable?.onAgentChange}
          agentLabel="Chat agent"
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
          active={input.active}
          actionLabel={
            input.active
              ? "Stop agent response"
              : (props.sendLabel ?? "Send chat message")
          }
          actionDisabled={
            input.active
              ? !props.onStop || !props.active || input.pending
              : input.unavailable || !hasDraft
          }
          onAction={() => {
            if (input.active) void input.stop();
            else input.submit();
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
          <ConversationQueue input={input} focus={focus} />
          {props.attachments?.length || props.attachmentUploading ? (
            <div className="fdy-chat-attachment-stage">
              <AttachmentList
                attachments={props.attachments ?? []}
                onPreview={onPreview}
                onRemove={props.onAttachmentRemove}
                removable
              />
              {props.attachmentUploading ? (
                <span className="fdy-chat-attachment-uploading">
                  <Paperclip size={14} />
                  Uploading...
                </span>
              ) : null}
            </div>
          ) : null}
          {input.error ? (
            <Alert tone="error" title="Could not complete request">
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
