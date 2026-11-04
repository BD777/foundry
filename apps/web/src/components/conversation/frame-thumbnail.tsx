import { ImageOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { sessionFrameImageUrl } from "../../api";
import { useCachedImage } from "../../lib/image-cache";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import type { ConversationToolFrame } from "./conversation-types";

type ThumbState = "loading" | "ready" | "failed";

/** A fixed 16:9 box in the row's size, so a missing image never collapses it. */
const thumbSizes = {
  step: "w-40",
  row: "w-24",
  strip: "w-[72px]",
} as const;

const thumbFrame =
  "fdy-frame-thumb relative inline-flex flex-none aspect-video items-center justify-center overflow-hidden rounded-md bg-panel-soft p-0 text-ink-faint";
const loadingPulse = (phase: ThumbState) =>
  phase === "loading" && "animate-pulse motion-reduce:animate-none";

/** A frame's derivative, read through its session once per page. */
function useFrameImage(
  frame: ConversationToolFrame,
  variant: "preview" | "placeholder",
): { phase: ThumbState; src?: string } {
  const image = useCachedImage(
    sessionFrameImageUrl(frame.sessionId, frame.id),
    variant,
  );
  return image.phase === "ready"
    ? { phase: "ready", src: image.url }
    : image.phase === "error"
      ? { phase: "failed" }
      : { phase: "loading" };
}

/** When a frame was taken, as the viewer reads time. */
export function frameTime(frame: ConversationToolFrame, language: string) {
  const at = new Date(frame.capturedAt);
  return Number.isNaN(at.getTime())
    ? ""
    : at.toLocaleTimeString(language, {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
}

/**
 * A tool step's screenshot as a 16:9 button. A step shows the bounded
 * preview; the panel's filmstrip the tiny placeholder.
 */
export function FrameThumbnail({
  frame,
  label,
  onOpen,
  selected,
  size = "step",
  tabIndex,
}: {
  frame: ConversationToolFrame;
  /** Names the frame for assistive technology. */
  label: string;
  /** Without it the thumbnail is a picture inside its row's own button. */
  onOpen?: () => void;
  /** In a filmstrip: whether it is the frame shown. */
  selected?: boolean;
  size?: "step" | "strip" | "row";
  tabIndex?: number;
}) {
  const { t } = useTranslation("conversation");
  const image = useFrameImage(
    frame,
    size === "step" ? "preview" : "placeholder",
  );
  const content =
    image.phase === "ready" && image.src ? (
      <img alt="" className="block size-full object-contain" src={image.src} />
    ) : image.phase === "failed" ? (
      <span className="inline-flex items-center gap-1.5 px-1.5 text-2xs leading-tight">
        <ImageOff aria-hidden="true" size={size === "strip" ? 14 : 16} />
        {size === "strip" ? null : <span>{t("process.frameFailed")}</span>}
      </span>
    ) : null;
  if (!onOpen)
    return (
      <span
        aria-hidden="true"
        className={cn(thumbFrame, thumbSizes[size], loadingPulse(image.phase))}
        data-size={size}
        data-state={image.phase}
      >
        {content}
      </span>
    );
  return (
    <Button
      aria-busy={image.phase === "loading"}
      aria-label={label}
      aria-pressed={selected}
      className={cn(
        thumbFrame,
        thumbSizes[size],
        size === "strip" ? "cursor-pointer" : "cursor-zoom-in",
        "hover:shadow-[0_0_0_1px_var(--line-strong)]",
        selected && "border-2 border-ink",
        loadingPulse(image.phase),
      )}
      data-selected={selected ? "true" : undefined}
      data-size={size}
      data-state={image.phase}
      onClick={onOpen}
      tabIndex={tabIndex}
      title={label}
      variant="bare"
    >
      {content}
    </Button>
  );
}
