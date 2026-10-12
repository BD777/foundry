import { i18n } from "../../i18n";
import type { FeishuBotStatus } from "@bd777/foundry-protocol";

const relativeUnits: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

/** "3 minutes ago": a timestamp relative to now. */
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

/** A time of day, in the reader's locale. */
export function clockTime(iso: string | undefined): string {
  const at = iso ? new Date(iso) : undefined;
  return at && Number.isFinite(at.getTime())
    ? at.toLocaleTimeString(i18n.language, {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
}

export function statusTone(
  status: FeishuBotStatus | undefined,
): "online" | "brass" | "warn" | "neutral" {
  switch (status) {
    case "connected":
      return "online";
    case "connecting":
      return "brass";
    case "error":
      return "warn";
    default:
      return "neutral";
  }
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
