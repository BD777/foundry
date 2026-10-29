import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { SessionToolFrameList } from "@bd777/foundry-protocol";
import { ChevronLeft, ChevronRight, SkipForward } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  isAbortError,
  listSessionFrames,
  sessionFrameImageUrl,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { FieldHint } from "../../components/ui/field";
import { LoadingState } from "../../components/ui/loading";
import { ScrollArea } from "../../components/ui/scroll-area";
import { LocalImage } from "../../components/conversation/local-image";
import {
  FrameThumbnail,
  frameTime,
} from "../../components/conversation/frame-thumbnail";
import type {
  ConversationToolFrame,
  ParsedImageTag,
} from "../../components/conversation/conversation-types";
import { formatBytes } from "../../lib/format";
import type { ChatScreenItem } from "./chat-types";

/**
 * A session's tool screenshots (DEV-075): the frame shown, then a filmstrip
 * of all of them, oldest first. It follows the newest frame until the
 * person picks an older one.
 */
export function ScreenDetail({
  item,
  onClose,
  onImagePreview,
}: {
  item: ChatScreenItem;
  /** Escape inside the screen closes it. */
  onClose?: () => void;
  onImagePreview?: (image: ParsedImageTag) => void;
}) {
  const { t, i18n } = useTranslation(["chat", "conversation"]);
  const [list, setList] = useState<SessionToolFrameList>();
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // undefined: follow the newest frame.
  const [chosen, setChosen] = useState<string | undefined>(item.frameId);
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => setChosen(item.frameId), [item.frameId, item.sessionId]);
  // Read again when a newer frame arrives, or on retry.
  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    listSessionFrames(item.sessionId, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setList(value);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted && !isAbortError(reason)) setError(true);
      });
    return () => controller.abort();
  }, [item.sessionId, item.latest.id, attempt]);

  if (!list) {
    return error ? (
      <div className="fdy-chat-detail-feedback">
        <Alert
          size="compact"
          title={t("chat:detail.screen.failed")}
          tone="error"
        >
          <Button onClick={() => setAttempt((value) => value + 1)} size="sm">
            {t("chat:detail.screen.retry")}
          </Button>
        </Alert>
      </div>
    ) : (
      <LoadingState label={t("chat:detail.screen.loading")} layout="block" />
    );
  }
  const frames: ConversationToolFrame[] = list.frames.map((frame) => ({
    ...frame,
    sessionId: item.sessionId,
  }));
  if (frames.length === 0) {
    return (
      <div className="fdy-chat-detail-empty">
        {t("chat:detail.screen.empty")}
      </div>
    );
  }
  const chosenIndex = chosen
    ? frames.findIndex((frame) => frame.id === chosen)
    : -1;
  const index = chosenIndex >= 0 ? chosenIndex : frames.length - 1;
  const following = chosenIndex < 0;
  const frame = frames[index]!;
  const label = (value: ConversationToolFrame, at: number) =>
    t("chat:detail.screen.frameLabel", {
      index: at + 1,
      count: frames.length,
      source: t(`conversation:process.frameSource.${value.source}`),
      time: frameTime(value, i18n.language),
    });
  const select = (next: number, focus = false) => {
    const bounded = Math.max(0, Math.min(frames.length - 1, next));
    // The newest frame chosen by hand still stops following: the person
    // asked for that one.
    setChosen(frames[bounded]!.id);
    if (focus)
      strip.current
        ?.querySelectorAll<HTMLButtonElement>(".fdy-frame-thumb")
        [bounded]?.focus();
  };
  const onStripKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, number> = {
      ArrowLeft: index - 1,
      ArrowRight: index + 1,
      Home: 0,
      End: frames.length - 1,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    select(next, true);
  };
  const source = sessionFrameImageUrl(item.sessionId, frame.id);
  const caption = label(frame, index);
  return (
    <div
      className="fdy-chat-screen-viewer"
      onKeyDown={(event) => {
        if (event.key === "Escape" && onClose) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="fdy-chat-screen-bar">
        <span className="fdy-chat-screen-position">
          {t("chat:detail.screen.position", {
            index: index + 1,
            count: frames.length,
          })}
          {" · "}
          {t(`conversation:process.frameSource.${frame.source}`)}
          {" · "}
          {frameTime(frame, i18n.language)}
          {frame.width && frame.height
            ? ` · ${frame.width}×${frame.height}`
            : ""}
        </span>
        {following ? (
          <span className="fdy-chat-screen-following">
            {t("chat:detail.screen.following")}
          </span>
        ) : (
          <Button
            onClick={() => setChosen(undefined)}
            size="sm"
            variant="secondary"
          >
            <SkipForward aria-hidden="true" size={13} />
            {t("chat:detail.screen.latest")}
          </Button>
        )}
      </div>
      <div className="fdy-chat-screen-frame">
        <LocalImage
          alt={caption}
          key={frame.id}
          onPreview={() =>
            onImagePreview?.({ alt: caption, path: frame.path, source })
          }
          path={frame.path}
          source={source}
        />
      </div>
      <p className="fdy-chat-screen-tool" title={frame.tool}>
        {frame.tool}
      </p>
      <div className="fdy-chat-screen-strip-row">
        <Button
          aria-label={t("chat:detail.screen.previous")}
          disabled={index === 0}
          onClick={() => select(index - 1)}
          size="icon"
          title={t("chat:detail.screen.previous")}
          variant="ghost"
        >
          <ChevronLeft size={16} />
        </Button>
        <ScrollArea className="fdy-chat-screen-strip-scroll">
          <div
            aria-label={t("chat:detail.screen.strip")}
            className="fdy-chat-screen-strip"
            onKeyDown={onStripKey}
            ref={strip}
            role="group"
          >
            {frames.map((value, at) => (
              <FrameThumbnail
                frame={value}
                key={value.id}
                label={label(value, at)}
                onOpen={() => select(at)}
                selected={at === index}
                size="strip"
                tabIndex={at === index ? 0 : -1}
              />
            ))}
          </div>
        </ScrollArea>
        <Button
          aria-label={t("chat:detail.screen.next")}
          disabled={index === frames.length - 1}
          onClick={() => select(index + 1)}
          size="icon"
          title={t("chat:detail.screen.next")}
          variant="ghost"
        >
          <ChevronRight size={16} />
        </Button>
      </div>
      <FieldHint>{t("chat:detail.screen.keyboardHint")}</FieldHint>
      {list.dropped > 0 ? (
        <p className="fdy-chat-detail-note">
          {t("chat:detail.screen.dropped", {
            count: list.dropped,
            limit: list.limits.count,
            size: formatBytes(list.limits.bytes),
          })}
        </p>
      ) : null}
      <p className="fdy-chat-detail-note">{t("chat:detail.screen.privacy")}</p>
    </div>
  );
}
