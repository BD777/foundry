import type { TFunction } from "i18next";
import type { ChoiceMenuOption } from "../ui/choice-menu";
import type { ComposerSubmitModifier } from "../ui/message-composer";
import type { ConversationDelivery } from "./conversation-types";

/**
 * When a message sent during a running turn enters it (DEV-082): Enter at
 * the turn's next step, Ctrl/⌘+Enter at once, Alt/⌥+Enter after the turn.
 */
export function deliveryForModifier(
  modifier: ComposerSubmitModifier,
): ConversationDelivery {
  return modifier === "mod"
    ? "interrupt"
    : modifier === "alt"
      ? "turn_end"
      : "boundary";
}

/** Whether this browser names its keys the Mac way (⌘, ⌥). */
export function macKeys(): boolean {
  return (
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
  );
}

export function deliveryShortcut(
  delivery: ConversationDelivery,
  mac = macKeys(),
): string {
  if (delivery === "interrupt") return mac ? "⌘ Enter" : "Ctrl+Enter";
  if (delivery === "turn_end") return mac ? "⌥ Enter" : "Alt+Enter";
  return "Enter";
}

/** The three ways to send during a turn, as the composer's menu lists them. */
export function deliveryOptions(
  t: TFunction<"conversation">,
  runtime: string | undefined,
  options: { disabled?: boolean; mac?: boolean; shortcuts?: boolean } = {},
): ChoiceMenuOption<ConversationDelivery>[] {
  const { disabled = false, mac = macKeys(), shortcuts = true } = options;
  const shortcut = (delivery: ConversationDelivery) =>
    shortcuts ? deliveryShortcut(delivery, mac) : undefined;
  return [
    {
      value: "boundary",
      label: t("delivery.boundary"),
      reason: t("delivery.boundaryReason"),
      shortcut: shortcut("boundary"),
      disabled,
    },
    {
      value: "interrupt",
      label: t("delivery.interrupt"),
      reason:
        runtime === "claude"
          ? t("delivery.interruptReasonClaude")
          : t("delivery.interruptReason"),
      shortcut: shortcut("interrupt"),
      disabled,
    },
    {
      value: "turn_end",
      label: t("delivery.turnEnd"),
      reason: t("delivery.turnEndReason"),
      shortcut: shortcut("turn_end"),
      disabled,
    },
  ];
}

/** "m:ss" left until at, from now; "0:00" once it passed. */
export function countdown(at: string | undefined, now: number): string {
  const target = at ? Date.parse(at) : Number.NaN;
  if (!Number.isFinite(target)) return "";
  const seconds = Math.max(0, Math.ceil((target - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
