import { useEffect, useMemo, useState } from "react";
import type { SessionToolFrameList } from "@bd777/foundry-protocol";
import { SkipForward } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  isAbortError,
  listSessionFrames,
  sessionFrameImageUrl,
} from "../../../api";
import { Alert } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { FieldHint } from "../../../components/ui/field";
import { LoadingState } from "../../../components/ui/loading";
import { Gallery } from "../../../components/ui/gallery";
import { frameTime } from "../../../components/conversation/frame-thumbnail";
import type {
  ConversationToolFrame,
  ParsedImageTag,
} from "../../../components/conversation/conversation-types";
import { formatBytes } from "../../../lib/format";
import type { ChatScreenItem } from "../chat-types";
import { DetailFeedback, DetailMessage } from "./chat-detail-parts";

/**
 * A session's tool screenshots (DEV-075) as an inline gallery: the frame
 * shown on a stage of fixed size and a strip of all of them, oldest first.
 * It follows the newest frame until the person picks an older one.
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
  const frames = useMemo<ConversationToolFrame[]>(
    () =>
      (list?.frames ?? []).map((frame) => ({
        ...frame,
        sessionId: item.sessionId,
      })),
    [list, item.sessionId],
  );
  const images = useMemo(
    () =>
      frames.map((value, at) => ({
        source: sessionFrameImageUrl(item.sessionId, value.id),
        alt: t("chat:detail.screen.frameLabel", {
          index: at + 1,
          count: frames.length,
          source: t(`conversation:process.frameSource.${value.source}`),
          time: frameTime(value, i18n.language),
        }),
      })),
    [frames, item.sessionId, t, i18n.language],
  );

  if (!list) {
    return error ? (
      <DetailFeedback>
        <Alert
          actions={
            <Button onClick={() => setAttempt((value) => value + 1)} size="sm">
              {t("chat:detail.screen.retry")}
            </Button>
          }
          size="compact"
          title={t("chat:detail.screen.failed")}
          tone="error"
        />
      </DetailFeedback>
    ) : (
      <LoadingState label={t("chat:detail.screen.loading")} layout="block" />
    );
  }
  if (frames.length === 0) {
    return <DetailMessage>{t("chat:detail.screen.empty")}</DetailMessage>;
  }
  const chosenIndex = chosen
    ? frames.findIndex((frame) => frame.id === chosen)
    : -1;
  const index = chosenIndex >= 0 ? chosenIndex : frames.length - 1;
  const following = chosenIndex < 0;
  const frame = frames[index]!;
  return (
    <div
      className="grid min-w-0 content-start gap-3 px-[clamp(14px,4cqi,28px)] pt-[18px] pb-10"
      onKeyDown={(event) => {
        if (event.key === "Escape" && onClose) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <span className="fdy-chat-screen-position text-xs text-ink-muted tabular-nums">
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
          <span className="text-xs text-ink-muted tabular-nums">
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
      <Gallery
        images={images}
        index={index}
        // The gallery reports the frame it shows, also on mount: only another
        // frame is a choice. The newest one chosen by hand still stops
        // following; the person asked for that one.
        onIndex={(next) => {
          if (next !== index) setChosen(frames[next]!.id);
        }}
        onOpen={(at) =>
          onImagePreview?.({
            alt: images[at]!.alt,
            path: frames[at]!.path,
            source: images[at]!.source,
          })
        }
      />
      <p
        className="truncate font-mono text-2xs text-ink-faint"
        title={frame.tool}
      >
        {frame.tool}
      </p>
      <FieldHint>{t("chat:detail.screen.keyboardHint")}</FieldHint>
      {list.dropped > 0 ? (
        <Alert
          size="compact"
          title={t("chat:detail.screen.dropped", {
            count: list.dropped,
            limit: list.limits.count,
            size: formatBytes(list.limits.bytes),
          })}
        />
      ) : null}
      <Alert size="compact" title={t("chat:detail.screen.privacy")} />
    </div>
  );
}
