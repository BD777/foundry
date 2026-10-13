import { i18n } from "../i18n";

const relativeUnits: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

/** "3 hours ago", "in 6 days": a timestamp relative to now. */
export function relativeWhen(
  iso: string | undefined,
  now = Date.now(),
): string {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(at)) return "";
  const delta = at - now;
  const format = new Intl.RelativeTimeFormat(i18n.language, {
    numeric: "auto",
  });
  for (const [unit, size] of relativeUnits)
    if (Math.abs(delta) >= size)
      return format.format(Math.round(delta / size), unit);
  return format.format(0, "minute");
}

/** The full date and time, in the reader's locale (for a tooltip). */
export function fullWhen(iso: string | undefined): string {
  const at = iso ? new Date(iso) : undefined;
  return at && Number.isFinite(at.getTime())
    ? at.toLocaleString(i18n.language)
    : "";
}

export interface ClockFormat {
  /** Add the date when it is not `now`'s day: "Oct 14" (short), "10/14" (2-digit). */
  date?: "short" | "2-digit";
  now?: Date;
  /** Force a 12- or 24-hour clock; by default the locale decides. */
  hour12?: boolean;
}

const clockDates = {
  short: { month: "short", day: "numeric" },
  "2-digit": { month: "2-digit", day: "2-digit" },
} as const;

/** "15:42", a time of day in the reader's locale; "" when missing or invalid. */
export function clockTime(
  value: string | Date | undefined,
  { date, now = new Date(), hour12 }: ClockFormat = {},
): string {
  const at = typeof value === "string" ? new Date(value) : value;
  if (!at || Number.isNaN(at.getTime())) return "";
  const otherDay = date && at.toDateString() !== now.toDateString();
  return at.toLocaleString(i18n.language, {
    ...(otherDay ? clockDates[date] : {}),
    hour12,
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "Oct 14, 2026, 3:42 PM" in the reader's locale; other text as it is. */
export function dateTime(
  value: string,
  timeStyle: "short" | "medium" = "short",
): string {
  const at = new Date(value);
  return Number.isNaN(at.getTime())
    ? value
    : at.toLocaleString(i18n.language, { dateStyle: "medium", timeStyle });
}

/** "Oct 14, 2026" in the reader's locale; other text as it is. */
export function dateOnly(value: string): string {
  const at = new Date(value);
  return Number.isNaN(at.getTime())
    ? value
    : at.toLocaleDateString(i18n.language, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}
