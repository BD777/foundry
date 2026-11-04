import { ImageOff, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ChatAttachment } from "@bd777/foundry-protocol";
import { localImageUrl } from "../../api";
import { formatBytes } from "../../lib/format";
import { cn } from "../../lib/cn";
import { useCachedImage } from "../../lib/image-cache";
import { Button } from "../ui/button";
import { fileIconForName } from "../ui/file-tree";
import { Spinner } from "../ui/loading";
import { Tooltip } from "../ui/tooltip";
import type { ParsedImageTag } from "./conversation-types";

function formatAttachmentSize(size: number): string {
  return !Number.isFinite(size) || size <= 0
    ? ""
    : formatBytes(size, { mbDigits: "adaptive" });
}

function RemoveAttachment({
  attachment,
  onRemove,
}: {
  attachment: ChatAttachment;
  onRemove?: (id: string) => void;
}) {
  const { t } = useTranslation("conversation");
  return (
    <Button
      aria-label={t("attachment.remove", { name: attachment.name })}
      className="absolute -top-1.5 -right-1.5 size-[22px] bg-(--fdy-media-surface) text-(--fdy-media-text) shadow-card hover:bg-(--fdy-media-surface)"
      onClick={() => onRemove?.(attachment.id)}
      size="icon"
      variant="ghost"
    >
      <X size={14} />
    </Button>
  );
}

/**
 * An image as a square tile of its preview, read through the shared image
 * cache: the lightbox it opens starts from the same preview.
 */
function ImageTile({
  attachment,
  onPreview,
  onRemove,
  removable,
}: {
  attachment: ChatAttachment;
  onPreview?: (image: ParsedImageTag) => void;
  onRemove?: (id: string) => void;
  removable: boolean;
}) {
  const { t } = useTranslation("conversation");
  const image = useCachedImage(localImageUrl(attachment.path), "preview");
  return (
    <div className="relative" data-kind="image">
      <Tooltip content={attachment.name}>
        <Button
          aria-label={t("image.preview", { name: attachment.name })}
          className="grid size-20 cursor-zoom-in place-items-center overflow-hidden rounded-xl bg-inset p-0 text-ink-faint shadow-btn"
          onClick={() =>
            onPreview?.({ alt: attachment.name, path: attachment.path })
          }
          variant="bare"
        >
          {image.phase === "ready" ? (
            <img
              alt={attachment.name}
              className="block size-full object-cover"
              draggable={false}
              src={image.url}
            />
          ) : image.phase === "error" ? (
            <ImageOff
              aria-label={t("attachment.unavailable", {
                name: attachment.name,
              })}
              size={18}
            />
          ) : (
            <Spinner />
          )}
        </Button>
      </Tooltip>
      {removable ? (
        <RemoveAttachment attachment={attachment} onRemove={onRemove} />
      ) : null}
    </div>
  );
}

/** Any other file as a compact chip: its icon, name and size. */
function FileChip({
  attachment,
  onRemove,
  removable,
}: {
  attachment: ChatAttachment;
  onRemove?: (id: string) => void;
  removable: boolean;
}) {
  const sizeLabel = formatAttachmentSize(attachment.size);
  return (
    <div
      className="relative flex h-10 max-w-60 min-w-0 items-center gap-2 rounded-xl bg-panel pr-3 pl-2.5 text-ink shadow-btn"
      data-kind="file"
    >
      <span className="flex-none text-ink-muted">
        {fileIconForName(attachment.name, 16)}
      </span>
      <span className="min-w-0 truncate text-xs leading-normal font-semibold">
        {attachment.name}
      </span>
      {sizeLabel ? (
        <span className="flex-none text-2xs leading-normal text-ink-faint tabular-nums">
          {sizeLabel}
        </span>
      ) : null}
      {removable ? (
        <RemoveAttachment attachment={attachment} onRemove={onRemove} />
      ) : null}
    </div>
  );
}

/**
 * A message's attachments: images as square tiles, other files as chips,
 * in one wrapping row. A sent message aligns the row with its bubble.
 */
export function AttachmentList({
  align = "start",
  attachments,
  onPreview,
  onRemove,
  removable = false,
}: {
  align?: "start" | "end";
  attachments: ChatAttachment[];
  onPreview?: (image: ParsedImageTag) => void;
  onRemove?: (id: string) => void;
  removable?: boolean;
}) {
  if (attachments.length === 0) {
    return null;
  }
  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-end gap-2",
        align === "end" && "justify-end",
      )}
    >
      {attachments.map((attachment) =>
        attachment.kind === "image" ? (
          <ImageTile
            attachment={attachment}
            key={attachment.id}
            onPreview={onPreview}
            onRemove={onRemove}
            removable={removable}
          />
        ) : (
          <FileChip
            attachment={attachment}
            key={attachment.id}
            onRemove={onRemove}
            removable={removable}
          />
        ),
      )}
    </div>
  );
}
