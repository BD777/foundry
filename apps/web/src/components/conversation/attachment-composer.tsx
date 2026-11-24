import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { Paperclip } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ChatAttachment } from "@bd777/foundry-protocol";
import {
  AgentComposer,
  type AgentComposerProps,
} from "../agent-runtime/agent-composer";
import { AttachmentList } from "./attachment-list";
import { ImagePreview } from "./local-image";
import type { ParsedImageTag } from "./conversation-types";
import { cn } from "../../lib/cn";

export interface AttachmentComposerProps extends Omit<
  AgentComposerProps,
  "fileInput" | "onAttach"
> {
  attachments?: ChatAttachment[];
  attachmentUploading?: boolean;
  /** Files picked, pasted or dropped; without it the composer takes none. */
  onAttachmentsAdd?: (files: File[]) => void;
  onAttachmentRemove?: (id: string) => void;
  /** Its message is being sent: no file is added or removed meanwhile. */
  locked?: boolean;
  /** Opens an attached image; without it the composer shows its own preview. */
  onPreview?: (image: ParsedImageTag) => void;
  /** Below the attachments: how the last request went. */
  after?: ReactNode;
}

/**
 * The agent composer that takes files the way every conversation does: the
 * "+" picker, pasting and dropping, and the attachment row above the input.
 * A composer inside another (the Needs you bar in a chat's composer) keeps
 * the files dropped on it.
 */
export function AttachmentComposer({
  attachments = [],
  attachmentUploading = false,
  onAttachmentsAdd,
  onAttachmentRemove,
  locked = false,
  onPreview,
  after,
  input,
  children,
  className,
  ...composer
}: AttachmentComposerProps) {
  const { t } = useTranslation("conversation");
  const files = useRef<HTMLInputElement | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [preview, setPreview] = useState<ParsedImageTag>();
  const openPreview = onPreview ?? setPreview;
  const addFiles = (list: FileList | File[] | null | undefined) => {
    if (locked) return;
    const selected = Array.from(list ?? []).filter((file) => file.size > 0);
    if (selected.length) onAttachmentsAdd?.(selected);
  };
  const takesFiles = (event: DragEvent<HTMLDivElement>) =>
    Boolean(onAttachmentsAdd) && event.dataTransfer.types.includes("Files");
  return (
    <>
      <AgentComposer
        {...composer}
        input={{
          ...input,
          onPaste: (event) => {
            if (onAttachmentsAdd && event.clipboardData.files.length) {
              event.preventDefault();
              addFiles(event.clipboardData.files);
              return;
            }
            input.onPaste?.(event);
          },
        }}
        fileInput={
          onAttachmentsAdd
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
        onAttach={onAttachmentsAdd ? () => files.current?.click() : undefined}
        className={cn("data-[drag-active=true]:bg-accent-soft", className)}
        data-drag-active={dragActive ? "true" : "false"}
        onDragEnter={(event) => {
          if (!takesFiles(event)) return;
          event.preventDefault();
          event.stopPropagation();
          setDragActive(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setDragActive(false);
        }}
        onDragOver={(event) => {
          if (!takesFiles(event)) return;
          event.preventDefault();
          event.stopPropagation();
        }}
        onDrop={(event) => {
          if (!onAttachmentsAdd || !event.dataTransfer.files.length) return;
          event.preventDefault();
          event.stopPropagation();
          setDragActive(false);
          addFiles(event.dataTransfer.files);
        }}
      >
        {children}
        {attachments.length || attachmentUploading ? (
          <div className="flex min-w-0 flex-wrap items-start gap-2 pt-0.5 pb-[9px]">
            <AttachmentList
              attachments={attachments}
              onPreview={openPreview}
              onRemove={locked ? undefined : onAttachmentRemove}
              removable={!locked}
            />
            {attachmentUploading ? (
              <span className="inline-flex h-8 items-center gap-1.5 rounded-full bg-panel-soft px-2.5 text-xs font-[650] text-ink-muted">
                <Paperclip size={14} />
                {t("composer.uploading")}
              </span>
            ) : null}
          </div>
        ) : null}
        {after}
      </AgentComposer>
      {preview ? (
        <ImagePreview image={preview} onClose={() => setPreview(undefined)} />
      ) : null}
    </>
  );
}
