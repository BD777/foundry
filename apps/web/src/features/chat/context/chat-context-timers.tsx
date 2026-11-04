import { Clock, Repeat } from "lucide-react";
import { useTranslation } from "react-i18next";
import { i18n } from "../../../i18n";
import {
  ContextRow,
  ContextRowCopy,
  ContextRowIcon,
} from "./chat-context-parts";
import { timerNextRun } from "./chat-schedule-model";
import type { ChatContextSelection, ChatTimerItem } from "../chat-types";

function formatNextFireLabel(iso?: string): string {
  if (!iso) {
    return "";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const isTomorrow = date.toDateString() === tomorrow.toDateString();
  const time = date.toLocaleTimeString(i18n.language, {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  if (sameDay) {
    return i18n.t("chat:contextCard.today", { time });
  }
  if (isTomorrow) {
    return i18n.t("chat:contextCard.tomorrow", { time });
  }
  return date.toLocaleString(i18n.language, {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function TimerRow({
  item,
  onSelect,
  selected,
}: {
  item: ChatTimerItem;
  onSelect?: (item: ChatContextSelection) => void;
  selected: boolean;
}) {
  const { t } = useTranslation("chat");
  // Only a timer the server's schedule holds fires. Recompute on each
  // render, from its last wake: the reported next fire goes stale within a
  // cycle.
  const scheduled = item.scheduled;
  const next = scheduled
    ? timerNextRun(scheduled, item.wake, item.busy)
    : undefined;
  const nextFire = formatNextFireLabel(
    next?.at?.toISOString() ?? scheduled?.nextFireAt,
  );
  const runningSince = item.running?.startedAt
    ? formatNextFireLabel(item.running.startedAt)
    : "";
  const status = !scheduled
    ? t("contextCard.timerInactive")
    : runningSince
      ? t("contextCard.timerRunning", { time: runningSince })
      : next?.due
        ? t(item.busy ? "contextCard.timerDue" : "contextCard.timerDueNow")
        : nextFire
          ? t("contextCard.nextFire", { time: nextFire })
          : "";
  const fireCount = item.fires.length;
  return (
    <ContextRow
      aria-pressed={selected}
      onClick={() => onSelect?.(item)}
      selected={selected}
      title={item.detail ?? item.label}
    >
      <ContextRowIcon kind="timer">
        {item.task.recurring ? (
          <Repeat aria-hidden="true" size={16} />
        ) : (
          <Clock aria-hidden="true" size={16} />
        )}
      </ContextRowIcon>
      <ContextRowCopy
        detail={
          <>
            {status}
            {status && fireCount > 0 ? " · " : ""}
            {fireCount > 0
              ? t("contextCard.fireCount", { count: fireCount })
              : ""}
          </>
        }
        title={item.label}
      />
    </ContextRow>
  );
}
