import YetAnotherLightbox, {
  type Labels,
  type Slide,
  type SlotStyles,
} from "yet-another-react-lightbox";
import type { TFunction } from "i18next";
import Inline from "yet-another-react-lightbox/plugins/inline";
import Thumbnails from "yet-another-react-lightbox/plugins/thumbnails";
import { ImageOff } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useCachedImage } from "../../lib/image-cache";
import { Button } from "./button";
import { Spinner } from "./loading";

/*
 * An inline gallery: the chosen image on a stage of fixed size and a
 * thumbnail strip under it, from yet-another-react-lightbox's Inline and
 * Thumbnails plugins (the library the Lightbox wraps). Arrow keys and swipe
 * move between images. Images are read through the shared image cache:
 * thumbnails and the stage start from the preview, the stage swaps to the
 * original when it arrives, and the Lightbox it opens reuses both. Themed
 * only through the library's `--yarl__*` variables, set on its root
 * through `styles` (the root of an inline gallery has no `className`).
 */
const themeStyle: SlotStyles["root"] = {
  "--yarl__color_backdrop": "var(--inset)",
  "--yarl__color_button": "var(--ink-2)",
  "--yarl__color_button_active": "var(--ink)",
  "--yarl__color_button_disabled":
    "color-mix(in oklab, var(--ink-2) 35%, transparent)",
  "--yarl__button_filter": "none",
  "--yarl__thumbnails_container_background_color": "transparent",
  // Room for the focus ring (2px) on the sides and below.
  "--yarl__thumbnails_container_padding": "10px 2px 2px",
  "--yarl__thumbnails_thumbnail_background": "var(--inset)",
  "--yarl__thumbnails_thumbnail_border_color": "var(--line)",
  "--yarl__thumbnails_thumbnail_active_border_color": "var(--fdy-accent)",
  "--yarl__thumbnails_thumbnail_focus_box_shadow":
    "0 0 0 2px var(--fdy-accent)",
  "--yarl__thumbnails_thumbnail_icon_color": "var(--ink-3)",
};

/** The library's label keys are its own English names; the values are ours. */
function galleryLabels(t: TFunction<"ui">): Labels {
  return {
    Previous: t("gallery.previous"),
    Next: t("gallery.next"),
    Carousel: t("gallery.carousel"),
    Slide: t("gallery.slide"),
    Thumbnails: t("gallery.thumbnails"),
    "Photo gallery": t("gallery.photoGallery"),
    // The library puts the numbers in.
    "{index} of {total}": t("gallery.position", {
      index: "{index}",
      total: "{total}",
    }),
  };
}

export interface GalleryImage {
  /** Where the image is read (an API URL). */
  source: string;
  alt: string;
}

function GallerySlide({
  current,
  image,
  onOpen,
}: {
  /** The slide shown; neighbours the carousel renders ahead stay previews. */
  current: boolean;
  image: GalleryImage;
  onOpen?: () => void;
}) {
  const { t } = useTranslation("ui");
  const preview = useCachedImage(image.source, "preview");
  const original = useCachedImage(image.source, "original", current);
  const src =
    original.phase === "ready"
      ? original.url
      : preview.phase === "ready"
        ? preview.url
        : undefined;
  return (
    <Button
      aria-label={t("gallery.open", { name: image.alt })}
      // The slide's box is the only size the image follows: positioned against
      // it, max-height and max-width resolve, so a tall screenshot fits and
      // stays centred instead of overflowing an auto-sized grid row.
      className="relative grid size-full cursor-zoom-in place-items-center p-0 text-ink-faint"
      onClick={onOpen}
      variant="bare"
    >
      {src ? (
        <img
          alt={image.alt}
          className="absolute inset-0 m-auto block max-h-full max-w-full object-contain"
          draggable={false}
          src={src}
        />
      ) : original.phase === "error" && preview.phase === "error" ? (
        <ImageOff aria-label={t("gallery.unavailable")} size={22} />
      ) : (
        <Spinner />
      )}
    </Button>
  );
}

function GalleryThumbnail({ image }: { image: GalleryImage }) {
  const { t } = useTranslation("ui");
  const preview = useCachedImage(image.source, "preview");
  return preview.phase === "ready" ? (
    <img
      alt=""
      className="block size-full object-cover"
      draggable={false}
      src={preview.url}
    />
  ) : preview.phase === "error" ? (
    <ImageOff aria-label={t("gallery.unavailable")} size={16} />
  ) : (
    <Spinner />
  );
}

export function Gallery({
  images,
  index,
  onIndex,
  onOpen,
}: {
  /** Keep the same array while the images are the same (`useMemo`). */
  images: GalleryImage[];
  index: number;
  /** The person moved to another image. */
  onIndex: (index: number) => void;
  /** Opens an image in the Lightbox. */
  onOpen?: (index: number) => void;
}) {
  const { t } = useTranslation("ui");
  // A new slides array resets the library's state (and cuts its animation),
  // so it changes only with the images.
  const slides = useMemo(
    () =>
      images.map((image) => ({ src: image.source, alt: image.alt })) as Slide[],
    [images],
  );
  return (
    <YetAnotherLightbox
      styles={{ root: themeStyle }}
      plugins={[Inline, Thumbnails]}
      inline={{
        className: "rounded-xl",
        style: { width: "100%", aspectRatio: "4 / 3", maxHeight: "70vh" },
      }}
      slides={slides}
      index={index}
      on={{ view: ({ index: next }) => onIndex(next) }}
      // Escape belongs to the page (it closes the panel), not to an inline
      // gallery, which has nothing to close.
      controller={{ closeOnEscape: false }}
      carousel={{ finite: true, padding: 0, spacing: 0 }}
      thumbnails={{
        position: "bottom",
        width: 96,
        height: 60,
        border: 1,
        borderRadius: 10,
        padding: 0,
        gap: 8,
        imageFit: "cover",
        vignette: false,
        showToggle: false,
      }}
      labels={galleryLabels(t)}
      render={{
        slide: ({ slide, offset }) => {
          const at = slides.indexOf(slide);
          return (
            <GallerySlide
              current={offset === 0}
              image={images[at]!}
              onOpen={onOpen ? () => onOpen(at) : undefined}
            />
          );
        },
        thumbnail: ({ slide }) => (
          <GalleryThumbnail image={images[slides.indexOf(slide)]!} />
        ),
      }}
    />
  );
}
