import { i18n } from "../../i18n";
import { clockTime } from "../../lib/time-format";

/** Ignore missing/invalid legacy dates and keep the most recent known activity. */
export function latestChatTime(
  values: (string | undefined)[],
): string | undefined {
  const timestamps = values
    .map((value) => (value ? Date.parse(value) : NaN))
    .filter(Number.isFinite);
  return timestamps.length
    ? new Date(Math.max(...timestamps)).toISOString()
    : undefined;
}

export function chatUpdateLabel(
  value: string | undefined,
  now = new Date(),
): string | undefined {
  if (!value || !Number.isFinite(Date.parse(value))) return undefined;
  const date = new Date(value);
  // Compare local calendar dates, not elapsed 24-hour periods (DST can vary).
  const calendarDay = (date: Date) =>
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
  const days = calendarDay(now) - calendarDay(date);
  if (days <= 0) {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
  return daysAgoLabel(days);
}

/** "yesterday", "3 days ago" in the interface language. */
function daysAgoLabel(days: number): string {
  return new Intl.RelativeTimeFormat(i18n.language, {
    numeric: "auto",
  }).format(-days, "day");
}

export interface ChatUpdateTime {
  label: string;
  title: string;
  dateTime?: string;
}

export function chatUpdateTime(
  value: string | undefined,
  now = new Date(),
): ChatUpdateTime {
  const label = chatUpdateLabel(value, now);
  if (label) {
    return {
      label,
      dateTime: value,
      title: i18n.t("chat:time.updatedAt", {
        time: new Date(value!).toLocaleString(i18n.language),
      }),
    };
  }
  // A stored duration has no reference date; subtracting it from now invents
  // a fresh timestamp every render. Wait for native history to supply one.
  return {
    label: i18n.t("chat:time.unknown"),
    title: i18n.t("chat:time.unknownTitle"),
  };
}

/** A clock time, with the date when it is not today's. */
export function noteTime(at: Date, now: Date): string {
  return clockTime(at, { date: "2-digit", now, hour12: false });
}
