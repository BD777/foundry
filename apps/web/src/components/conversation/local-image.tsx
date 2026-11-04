import { useState } from "react";
import { useTranslation } from "react-i18next";
import { localImageUrl } from "../../api";
import { formatBytes } from "../../lib/format";
import { useCachedImage } from "../../lib/image-cache";
import { Alert } from "../ui/alert";
import { Button } from "../ui/button";
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
  onPreview,
}: {
  path: string;
  /** Where the image is read instead of by its path (a session's frame). */
  source?: string;
  alt: string;
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
    >
      {!ready &&
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
      {preview.phase === "error" || broken ? (
        <Alert
          actions={
            <Button onClick={() => preview.retry(true)} size="sm">
              {t("image.retry")}
            </Button>
          }
          size="compact"
          title={t("image.failed")}
          tone="error"
        >
          {t(
            `image.${preview.phase === "error" ? preview.reason : "unavailable"}`,
          )}
        </Alert>
      ) : !ready ? (
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
