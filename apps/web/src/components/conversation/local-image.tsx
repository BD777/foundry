import { ChevronRight, CircleAlert, ImageOff, RotateCcw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { localImageUrl } from "../../api";
import { formatBytes } from "../../lib/format";
import { useCachedImage } from "../../lib/image-cache";
import { Button } from "../ui/button";
import { Disclosure, DisclosureSummary } from "../ui/disclosure";
import { Lightbox } from "../ui/lightbox";
import { Tooltip } from "../ui/tooltip";
import type { ParsedImageTag } from "./conversation-types";

/**
 * An image the agent mentioned, read from the device: one frame (rounded,
 * hairline ring, bounded height, its own aspect) that shows a blurred
 * placeholder while the preview derivative loads. The original is read only
 * when the lightbox opens or Download is pressed (`ImagePreview`).
 */
export function LocalImage({
  path,
  source: sourceUrl,
  alt,
  fallback = "status",
  onPreview,
}: {
  path: string;
  /** Where the image is read instead of by its path (a session's frame). */
  source?: string;
  alt: string;
  /** What to show before or instead of the image: progress or its alt text. */
  fallback?: "status" | "alt";
  onPreview?: () => void;
}) {
  const { t } = useTranslation("conversation");
  const source = sourceUrl ?? localImageUrl(path);
  const placeholder = useCachedImage(source, "placeholder");
  const preview = useCachedImage(source, "preview");
  // The bytes arrived; the image shows once the browser decoded them, and a
  // body it cannot decode is a failure with a retry, never a broken icon.
  const [decoded, setDecoded] = useState<string>();
  const [brokenUrl, setBrokenUrl] = useState<string>();
  const url = preview.phase === "ready" ? preview.url : undefined;
  const broken = url !== undefined && url === brokenUrl;
  const ready = url !== undefined && decoded === url && !broken;
  const failed = preview.phase === "error" || broken;
  const exportAlt = fallback === "alt";
  const failureReason =
    preview.phase === "error" ? preview.reason : "unavailable";
  const missing = failed && ["missing", "removed"].includes(failureReason);
  const filename = path.split(/[\\/]/).pop() || alt;
  const frame = url ? (
    <img
      alt={alt}
      className="block max-h-[min(420px,48vh)] max-w-full rounded-xl bg-panel-soft object-contain shadow-hairline"
      hidden={!ready}
      onError={() => setBrokenUrl(url)}
      onLoad={() => setDecoded(url)}
      src={url}
    />
  ) : null;
  return (
    <div
      className="min-w-0 max-w-full"
      aria-busy={!ready && preview.phase !== "error" && !broken}
      data-image-state={
        ready ? "ready" : missing ? "missing" : failed ? "error" : "loading"
      }
    >
      {!exportAlt &&
      !ready &&
      placeholder.phase === "ready" &&
      preview.phase !== "error" &&
      !broken ? (
        <img
          alt=""
          aria-hidden="true"
          className="block max-h-[min(420px,48vh)] w-[min(100%,640px)] max-w-full min-w-0 rounded-xl object-contain blur-[3px]"
          src={placeholder.url}
        />
      ) : null}
      {missing && !exportAlt ? (
        <Disclosure className="group w-fit max-w-full gap-1 text-sm leading-5">
          <DisclosureSummary className="flex max-w-full min-w-0 list-none items-center gap-1.5 [&::-webkit-details-marker]:hidden">
            <ImageOff
              aria-hidden="true"
              className="flex-none text-ink-faint"
              size={16}
            />
            <span className="flex-none font-medium">{t("image.missing")}</span>
            <span aria-hidden="true" className="flex-none text-ink-faint">
              ·
            </span>
            <span className="min-w-0 truncate font-mono text-xs text-ink-faint">
              {filename}
            </span>
            <ChevronRight
              aria-hidden="true"
              className="flex-none text-ink-faint transition-transform group-open:rotate-90"
              size={14}
            />
          </DisclosureSummary>
          <p className="m-0 pl-6 text-xs leading-[1.45] text-ink-faint [overflow-wrap:anywhere]">
            {path}
          </p>
        </Disclosure>
      ) : failed && !exportAlt ? (
        <div
          className="flex max-w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-panel-soft px-3 py-2 text-sm leading-5 text-ink-muted"
          role="status"
        >
          <CircleAlert
            aria-hidden="true"
            className="flex-none text-ink-faint"
            size={16}
          />
          <span className="min-w-0 flex-1">
            <span className="font-medium text-ink">{t("image.failed")}</span>
            <span aria-hidden="true"> · </span>
            <span>{t(`image.${failureReason}`)}</span>
          </span>
          <Button
            className="ms-auto"
            onClick={() => preview.retry(true)}
            size="sm"
            variant="ghost"
          >
            <RotateCcw aria-hidden="true" size={14} />
            {t("image.retry")}
          </Button>
        </div>
      ) : !ready && !exportAlt ? (
        <p
          className="rounded-xl bg-panel-soft p-4 text-sm text-ink-muted"
          role="status"
        >
          {preview.phase === "loading" && preview.progress.received > 0
            ? t(
                preview.progress.total
                  ? "image.progress"
                  : "image.progressUnknown",
                {
                  received: formatBytes(preview.progress.received),
                  total: formatBytes(preview.progress.total || 0),
                },
              )
            : t(
                preview.phase === "loading" && preview.retrying
                  ? "image.retrying"
                  : "image.loading",
              )}
        </p>
      ) : !ready && exportAlt ? (
        <p className="rounded-xl bg-panel-soft p-4 text-sm text-ink-muted">
          {alt}
        </p>
      ) : null}
      {frame && onPreview ? (
        <Tooltip content={t("image.previewTip")}>
          <Button
            aria-label={t("image.preview", { name: alt })}
            className="block h-auto w-fit max-w-full cursor-zoom-in rounded-xl p-0"
            hidden={!ready}
            onClick={onPreview}
            variant="bare"
          >
            {frame}
          </Button>
        </Tooltip>
      ) : (
        frame
      )}
    </div>
  );
}

/** The lightbox for a message's image (or a session frame). */
export function ImagePreview({
  image,
  onClose,
}: {
  image: ParsedImageTag;
  onClose: () => void;
}) {
  return (
    <Lightbox
      image={{
        source: image.source ?? localImageUrl(image.path),
        name: image.alt || image.path.split(/[\\/]/).pop() || "image",
        filename: image.path.split(/[\\/]/).pop() || image.alt || "image",
      }}
      onClose={onClose}
    />
  );
}
