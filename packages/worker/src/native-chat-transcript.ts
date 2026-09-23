import type { TranscriptMessage } from "@foundry/protocol";
import { codexTranscriptRecord } from "./transcript-adapters/codex.js";
import { claudeTranscriptRecord } from "./transcript-adapters/claude.js";
import { record } from "./transcript-adapters/values.js";

const adapters = {
  codex: codexTranscriptRecord,
  claude: claudeTranscriptRecord,
};

/** Provider adapters preserve semantics; this reader only reconciles log mirrors. */
export function nativeChatTranscript(
  lines: string[],
  provider: keyof typeof adapters,
  truncated = false,
): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  const byId = new Map<string, number>();
  for (const [index, line] of lines.entries()) {
    let envelope;
    try {
      envelope = record(JSON.parse(line));
    } catch {
      continue;
    }
    for (const item of adapters[provider](envelope, `line-${index}`)) {
      if (!item.text.trim()) continue;
      const timestamp =
        typeof envelope.timestamp === "string"
          ? Date.parse(envelope.timestamp)
          : NaN;
      if (Number.isFinite(timestamp))
        item.at = new Date(timestamp).toISOString();
      const key = `${item.kind}:${item.id}`;
      const existing = byId.get(key);
      if (existing !== undefined) {
        messages[existing] = { ...item, at: item.at ?? messages[existing]?.at };
        continue;
      }
      const previous = messages.at(-1);
      if (
        item.kind !== "tool" &&
        previous?.kind === item.kind &&
        previous.text.trim() === item.text.trim()
      ) {
        previous.at ??= item.at;
        byId.set(key, messages.length - 1);
        continue;
      }
      if (
        item.kind === "reasoning" &&
        previous?.kind === item.kind &&
        item.text.startsWith(previous.text)
      ) {
        // These are cumulative public summaries, not separate reasoning bodies.
        messages[messages.length - 1] = { ...item, id: previous.id };
        byId.set(key, messages.length - 1);
        continue;
      }
      byId.set(key, messages.length);
      messages.push(item);
    }
  }
  if (truncated)
    messages.push({
      id: "unloaded-tail",
      kind: "boundary",
      text: "本地会话较大，当前仅载入前段记录，后续内容尚未载入。",
    });
  return messages;
}
