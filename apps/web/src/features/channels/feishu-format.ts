import { i18n } from "../../i18n";
import type { FeishuBotStatus } from "@bd777/foundry-protocol";

export { relativeWhen } from "../../lib/relative-time";

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
