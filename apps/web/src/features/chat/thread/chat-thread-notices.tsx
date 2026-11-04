import { ChevronRight, CircleAlert, Clock, LoaderCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { useSharedNow } from "../../../lib/use-shared-now";
import { scheduledNote } from "../context/chat-schedule-model";
import type { ChatSurfaceProps, ChatThreadNotice } from "../chat-surface-types";

/** The line above the input: what runs on or wakes this chat. */
const noteButton = "mb-1 w-fit text-xs text-ink-muted";

type ChatSchedule = NonNullable<ChatSurfaceProps["schedule"]>;
type ChatScheduleWakes = ChatSurfaceProps["scheduleWakes"];

/**
 * The line above the input of an idle chat: what still runs in the
 * background or, else, when its timers wake it next. Each opens the panel.
 */
export function ChatWorkNote({
  backgroundNote,
  onRevealBackgroundWork,
  onRevealTimers,
  schedule,
  wakes,
}: {
  backgroundNote?: string;
  onRevealBackgroundWork: () => void;
  onRevealTimers: () => void;
  schedule?: ChatSchedule;
  wakes: ChatScheduleWakes;
}) {
  if (backgroundNote)
    return (
      <Button
        className={noteButton}
        onClick={onRevealBackgroundWork}
        size="sm"
        variant="ghost"
      >
        <LoaderCircle
          aria-hidden="true"
          className="flex-none animate-spin-slow motion-reduce:animate-none"
          size={14}
        />
        {backgroundNote}
      </Button>
    );
  return schedule ? (
    <ScheduledNote onClick={onRevealTimers} schedule={schedule} wakes={wakes} />
  ) : null;
}

/**
 * The line above the input while the workspace's device is offline: what is
 * sent waits for it, or (`onCancel`) the open chat already waits, and may be
 * cancelled.
 */
export function ChatDeviceNote({
  device,
  onCancel,
}: {
  device: string;
  onCancel?: () => Promise<void> | void;
}) {
  const { t } = useTranslation("chat");
  const [cancelling, setCancelling] = useState(false);
  async function cancel(): Promise<void> {
    setCancelling(true);
    try {
      await onCancel?.();
    } finally {
      setCancelling(false);
    }
  }
  return (
    <Alert
      actions={
        onCancel ? (
          <Button
            aria-busy={cancelling}
            disabled={cancelling}
            onClick={() => void cancel()}
            size="sm"
            variant="secondary"
          >
            {t("thread.cancelWaiting")}
          </Button>
        ) : undefined
      }
      className="mb-1.5"
      size="compact"
      title={
        onCancel
          ? t("thread.waitingForDevice", { device })
          : t("thread.deviceOffline", { device })
      }
      tone={onCancel ? "info" : "warning"}
    />
  );
}

/** The next wake-up of an idle chat's timers, kept current by the minute. */
function ScheduledNote(props: {
  onClick: () => void;
  schedule: ChatSchedule;
  wakes: ChatScheduleWakes;
}) {
  const { i18n } = useTranslation();
  const minute = Math.floor(useSharedNow(true) / 60_000);
  const note = useMemo(
    () =>
      scheduledNote(
        props.schedule,
        new Date(minute * 60_000),
        props.wakes?.wakes,
        props.wakes?.busy,
        props.wakes?.failedRun,
      ),
    // The note is written in the viewer's language.
    [props.schedule, props.wakes, minute, i18n.language],
  );
  return (
    <Button
      className={noteButton}
      onClick={props.onClick}
      size="sm"
      variant="ghost"
    >
      {props.wakes?.failedRun ? (
        <CircleAlert aria-hidden="true" className="flex-none" size={14} />
      ) : (
        <Clock aria-hidden="true" className="flex-none" size={14} />
      )}
      {note}
    </Button>
  );
}

/**
 * Shown in place of the composer: why the caller may only read, or why this
 * chat cannot be continued here, with where to go instead.
 */
export function ChatReadOnlyNotice({
  onShowList,
  readOnlyReason,
  threadNotice,
}: {
  onShowList: () => void;
  readOnlyReason?: string;
  threadNotice?: ChatThreadNotice;
}) {
  const { t } = useTranslation("chat");
  if (readOnlyReason)
    return <Alert title={t("thread.readOnly")}>{readOnlyReason}</Alert>;
  if (!threadNotice) return null;
  const action = threadNotice.action;
  return (
    <Alert
      actions={
        action ? (
          <Button
            onClick={() => {
              if (action.showsList) onShowList();
              action.onSelect();
            }}
            size="sm"
            variant="secondary"
          >
            {action.label}
            <ChevronRight aria-hidden="true" size={14} />
          </Button>
        ) : undefined
      }
      title={threadNotice.title}
      tone={threadNotice.tone}
    >
      {threadNotice.message}
    </Alert>
  );
}
