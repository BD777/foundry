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
