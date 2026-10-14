import type { TFunction } from "i18next";
import type {
  CodexTransport,
  CodexTransportMode,
  CodexTransportObservation,
} from "@bd777/foundry-protocol";
import { dateOnly } from "../../lib/time-format";

export const codexTransportOptions = (
  t: TFunction<"profiles">,
): Array<{ label: string; value: CodexTransportMode }> => [
  { label: t("codexTransport.auto"), value: "auto" },
  { label: t("codexTransport.websocket"), value: "websocket" },
  { label: t("codexTransport.https"), value: "https" },
];

function transportName(t: TFunction<"profiles">, transport: CodexTransport) {
  return t(`codexTransport.${transport}`);
}

/**
 * The transport a compatible Codex endpoint runs with and why: the choice
 * made here, else what a session showed, else that the next one learns it.
 */
export function codexTransportStatus(
  t: TFunction<"profiles">,
  mode: CodexTransportMode,
  learned: CodexTransportObservation | undefined,
  compact = false,
): string {
  if (mode !== "auto")
    return t(compact ? "codexTransport.cardChosen" : "codexTransport.chosen", {
      transport: transportName(t, mode),
    });
  if (!learned)
    return t(compact ? "codexTransport.cardUnknown" : "codexTransport.unknown");
  const transport = transportName(t, learned.transport);
  const date = dateOnly(learned.learnedAt);
  if (compact) return t("codexTransport.cardLearned", { transport, date });
  const reason =
    learned.transport === "websocket"
      ? t("codexTransport.streamed")
      : learned.detail
        ? t("codexTransport.fellBackDetail", { detail: learned.detail })
        : t("codexTransport.fellBack");
  return t("codexTransport.learned", { transport, date, reason });
}
