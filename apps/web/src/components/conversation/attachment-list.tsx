import { X } from "lucide-react";
import type { ChatAttachment } from "@bd777/foundry-protocol";
import { localImageUrl } from "../../api";
import { formatBytes } from "../../lib/format";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { fileIconForName } from "../ui/file-tree";
import type { ParsedImageTag } from "./conversation-types";

function formatAttachmentSize(size: number): string {
  return !Number.isFinite(size) || size <= 0
    ? ""
    : formatBytes(size, { mbDigits: "adaptive" });
}

function AttachmentPreviewItem({
  attachment,
  onPreview,
  onRemove,
  removable = false,
}: {
  attachment: ChatAttachment;
  onPreview?: (image: ParsedImageTag) => void;
  onRemove?: (id: string) => void;
  removable?: boolean;
}) {
  const sizeLabel = formatAttachmentSize(attachment.size);
  return (
    <div
      className={cn(
        "relative grid min-w-0 items-center gap-2 rounded-xl bg-panel py-1.5 pr-2 pl-1.5 text-ink shadow-card",
        attachment.kind === "image"
          ? "w-[150px] grid-cols-[46px_minmax(0,1fr)]"
          : "w-44 grid-cols-[42px_minmax(0,1fr)]",
      )}
      data-kind={attachment.kind}
    >
      {attachment.kind === "image" ? (
        <Button
          aria-label={`Preview ${attachment.name}`}
          className="block size-[46px] cursor-zoom-in overflow-hidden rounded-lg bg-control-hover p-0"
          onClick={() =>
            onPreview?.({ alt: attachment.name, path: attachment.path })
          }
          variant="bare"
        >
          <img
            alt={attachment.name}
            className="block size-full object-cover"
            loading="lazy"
            src={localImageUrl(attachment.path)}
          />
        </Button>
      ) : (
        <span className="inline-flex size-[42px] items-center justify-center rounded-lg bg-control-hover text-ink-muted">
          {fileIconForName(attachment.name, 17)}
        </span>
      )}
      <span className="grid min-w-0 gap-0.5">
        <strong className="truncate text-xs leading-tight font-bold text-ink">
          {attachment.name}
        </strong>
        {sizeLabel ? (
          <em className="truncate text-2xs leading-tight font-semibold text-ink-faint not-italic">
            {sizeLabel}
          </em>
        ) : null}
      </span>
      {removable ? (
        <Button
          aria-label={`Remove ${attachment.name}`}
          className="absolute -top-[7px] -right-[7px] size-[22px] bg-(--fdy-media-surface) text-(--fdy-media-text) shadow-card hover:bg-(--fdy-media-surface)"
          onClick={() => onRemove?.(attachment.id)}
          size="icon"
          variant="ghost"
        >
          <X size={14} />
        </Button>
      ) : null}
    </div>
  );
}

export function AttachmentList({
  attachments,
  onPreview,
  onRemove,
  removable = false,
}: {
  attachments: ChatAttachment[];
  onPreview?: (image: ParsedImageTag) => void;
  onRemove?: (id: string) => void;
  removable?: boolean;
}) {
  if (attachments.length === 0) {
    return null;
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {attachments.map((attachment) => (
        <AttachmentPreviewItem
          attachment={attachment}
          key={attachment.id}
          onPreview={onPreview}
          onRemove={onRemove}
          removable={removable}
        />
      ))}
    </div>
  );
}
