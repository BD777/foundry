import YetAnotherLightbox, {
  type Labels,
  type Slide,
  type SlideImage,
  type SlotStyles,
} from "yet-another-react-lightbox";
import Download from "yet-another-react-lightbox/plugins/download";
import Fullscreen from "yet-another-react-lightbox/plugins/fullscreen";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import { useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { downloadOriginal, useCachedImage } from "../../lib/image-cache";
import { formatBytes } from "../../lib/format";
import { Alert } from "./alert";
import { Button } from "./button";
import { Spinner } from "./loading";

/*
 * Wraps yet-another-react-lightbox (MIT, https://github.com/igordanchenko/
 * yet-another-react-lightbox) with its Zoom, Download and Fullscreen plugins:
 * the standard toolbar (zoom, download, fullscreen, close), Escape, arrows
 * and swipe. Its stylesheet comes in once from styles.css; it is themed only
 * through its documented `--yarl__*` variables through `styles.root`, mapped to
 * the media tokens.
 */
const themeStyle: SlotStyles["root"] = {
  "--yarl__color_backdrop": "var(--fdy-media-surface)",
  "--yarl__color_button": "var(--fdy-media-text)",
  "--yarl__color_button_active": "var(--fdy-brand-on-color)",
  "--yarl__color_button_disabled":
    "color-mix(in oklab, var(--fdy-media-text) 40%, transparent)",
  "--yarl__button_filter": "none",
  "--yarl__slide_icon_loading_color": "var(--fdy-media-text)",
  "--yarl__portal_zindex": "95",
};

/** A transparent pixel while neither derivative has arrived. */
const blank =
  "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

/** The library's label keys are its own English names; the values are ours. */
function lightboxLabels(t: TFunction<"ui">): Labels {
  return {
    Previous: t("lightbox.previous"),
    Next: t("lightbox.next"),
    Close: t("lightbox.close"),
    "Zoom in": t("lightbox.zoomIn"),
    "Zoom out": t("lightbox.zoomOut"),
    Download: t("lightbox.download"),
    "Enter Fullscreen": t("lightbox.enterFullscreen"),
    "Exit Fullscreen": t("lightbox.exitFullscreen"),
    Lightbox: t("lightbox.dialog"),
    // The library puts the numbers in.
    "{index} of {total}": t("lightbox.position", {
      index: "{index}",
      total: "{total}",
    }),
  };
}

export interface LightboxImage {
  /** Where the image is read (an API URL); the original is read from it. */
  source: string;
  /** Names the slide. */
  name: string;
  /** The file name a download saves under (the original's, with its extension). */
  filename: string;
}

/**
 * The slide opens at once with the inline preview (already loaded by the
 * view that opened it, so nothing is read twice), then swaps to the original
 * when it arrives; Download saves the original, reading it first if need be.
 */
export function Lightbox({
  image,
  onClose,
}: {
  image: LightboxImage;
  onClose: () => void;
}) {
  const { t } = useTranslation("ui");
  const preview = useCachedImage(image.source, "preview");
  const placeholder = useCachedImage(
    image.source,
    "placeholder",
    preview.phase !== "ready",
  );
  const original = useCachedImage(image.source, "original");
  const src =
    original.phase === "ready"
      ? original.url
      : preview.phase === "ready"
        ? preview.url
        : placeholder.phase === "ready"
          ? placeholder.url
          : blank;
  const slide: SlideImage = { src, alt: image.name };
  const [failedDownload, setFailedDownload] = useState(false);
  return (
    <YetAnotherLightbox
      open
      close={onClose}
      styles={{ root: themeStyle }}
      slides={[slide] as Slide[]}
      plugins={[Zoom, Download, Fullscreen]}
      zoom={{ maxZoomPixelRatio: 3, scrollToZoom: true }}
      carousel={{ finite: true }}
      controller={{ closeOnBackdropClick: true }}
      download={{
        download: () => {
          setFailedDownload(false);
          void downloadOriginal(image.source, image.filename).catch(() =>
            setFailedDownload(true),
          );
        },
      }}
      labels={lightboxLabels(t)}
      render={{
        // One image: no arrows (they would be disabled anyway).
        buttonPrev: () => null,
        buttonNext: () => null,
        slideFooter: () => (
          <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-4">
            {original.phase === "error" ? (
              <Alert
                actions={
                  <Button onClick={() => original.retry()} size="sm">
                    {t("lightbox.retry")}
                  </Button>
                }
                className="pointer-events-auto max-w-md"
                size="compact"
                title={t("lightbox.failed")}
                tone="error"
              >
                {t(`lightbox.reason.${original.reason}`)}
              </Alert>
            ) : failedDownload ? (
              <Alert
                className="pointer-events-auto max-w-md"
                size="compact"
                title={t("lightbox.downloadFailed")}
                tone="error"
              />
            ) : original.phase === "loading" ? (
              <p
                className="inline-flex items-center gap-2 rounded-full bg-black/55 px-3 py-1.5 text-xs text-white"
                role="status"
              >
                <Spinner />
                {original.progress.received > 0
                  ? t(
                      original.progress.total
                        ? "lightbox.progress"
                        : "lightbox.progressUnknown",
                      {
                        received: formatBytes(original.progress.received),
                        total: formatBytes(original.progress.total || 0),
                      },
                    )
                  : t("lightbox.loadingOriginal")}
              </p>
            ) : null}
          </div>
        ),
      }}
    />
  );
}
