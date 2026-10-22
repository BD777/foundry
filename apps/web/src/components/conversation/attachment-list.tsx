import { X } from "lucide-react";
import type { ChatAttachment } from "@bd777/foundry-protocol";
import { localImageUrl } from "../../api";
import { formatBytes } from "../../lib/format";
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
    <div className="fdy-chat-attachment" data-kind={attachment.kind}>
      {attachment.kind === "image" ? (
        <Button
          aria-label={`Preview ${attachment.name}`}
          className="fdy-chat-attachment-thumb"
          onClick={() =>
            onPreview?.({ alt: attachment.name, path: attachment.path })
          }
          variant="ghost"
        >
          <img
            alt={attachment.name}
            loading="lazy"
            src={localImageUrl(attachment.path)}
          />
        </Button>
      ) : (
        <span className="fdy-chat-attachment-file-icon">
          {fileIconForName(attachment.name, 17)}
        </span>
      )}
      <span className="fdy-chat-attachment-copy">
        <strong>{attachment.name}</strong>
        {sizeLabel ? <em>{sizeLabel}</em> : null}
      </span>
      {removable ? (
        <Button
          aria-label={`Remove ${attachment.name}`}
          className="fdy-chat-attachment-remove"
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
    <div className="fdy-chat-attachments">
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
