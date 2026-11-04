import type { TFunction } from "i18next";
import type { NativeRuntime } from "./device-accounts";

/** "Claude subscription" / "ChatGPT subscription", in the page's words. */
export function subscriptionName(
  t: TFunction<"profiles">,
  runtime: NativeRuntime,
): string {
  return runtime === "claude"
    ? t("subscriptions.claude")
    : t("subscriptions.codex");
}
