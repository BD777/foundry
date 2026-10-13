import type { FeishuBotStatus } from "@bd777/foundry-protocol";

export { errorText } from "../../lib/errors";
export { clockTime, relativeWhen } from "../../lib/time-format";

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
