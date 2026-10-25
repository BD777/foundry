import { processLabels, type TranscriptMessage } from "@bd777/foundry-protocol";
import { record, string, type JSONRecord } from "./json-values.js";

/** Claude can carry user-facing progress summaries in thinking blocks. */
export function claudeNarrationMessage(
  envelope: JSONRecord,
  value: unknown,
  index: number,
  fallbackId = "",
): TranscriptMessage | undefined {
  const block = record(value);
  const text = string(block.thinking);
  if (block.type !== "thinking" || !text.trim()) return undefined;
  const marked =
    Array.isArray(envelope.narration_block_indexes) &&
    envelope.narration_block_indexes.includes(index);
  // In updates mode only progress updates have readable thinking text.
  // Older/unmarked summarized thinking must keep its ordinary reasoning role.
  if (!marked && envelope.thinking_display !== "updates") return undefined;
  const id =
    string(envelope.uuid) || string(record(envelope.message).id) || fallbackId;
  return {
    id: id ? `${id}:${index}` : "",
    kind: "commentary",
    text,
    title: processLabels.commentary,
  };
}
