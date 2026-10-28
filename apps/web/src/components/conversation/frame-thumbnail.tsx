import { useEffect, useState } from "react";
import { ImageOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { sessionFrameImageUrl } from "../../api";
import { apiFetch } from "../../api/http";
import { Button } from "../ui/button";
import type { ConversationToolFrame } from "./conversation-types";
import "./frame-thumbnail.css";

type ThumbState = "loading" | "ready" | "failed";

/** A frame's derivative as an object URL, read through its session. */
function useFrameImage(
  frame: ConversationToolFrame,
  variant: "preview" | "placeholder",
) {
  const [state, setState] = useState<{ phase: ThumbState; src?: string }>({
    phase: "loading",
  });
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setState({ phase: "loading" });
    void (async () => {
      try {
        const response = await apiFetch(
          `${sessionFrameImageUrl(frame.sessionId, frame.id)}&variant=${variant}`,
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error(String(response.status));
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ phase: "ready", src: objectUrl });
      } catch {
        if (!controller.signal.aborted) setState({ phase: "failed" });
      }
    })();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [frame.sessionId, frame.id, variant]);
  return state;
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
      <img alt="" src={image.src} />
    ) : image.phase === "failed" ? (
      <span className="fdy-frame-thumb-failed">
        <ImageOff aria-hidden="true" size={size === "strip" ? 14 : 16} />
        {size === "strip" ? null : <span>{t("process.frameFailed")}</span>}
      </span>
    ) : null;
  if (!onOpen)
    return (
      <span
        aria-hidden="true"
        className="fdy-frame-thumb"
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
      className="fdy-frame-thumb"
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
