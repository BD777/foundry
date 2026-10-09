import { processLabels } from "@bd777/foundry-protocol";
import type { TranscriptMessage } from "@bd777/foundry-protocol";
import { codexTranscriptRecord } from "./transcript-adapters/codex.js";
import { claudeTranscriptRecord } from "./transcript-adapters/claude.js";
import { record } from "./transcript-adapters/values.js";
import { claudeNativeUsage, codexNativeUsage } from "./native-usage.js";
import { claudeRequestUsage } from "./turn-usage.js";

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
  const envelopes: unknown[] = [];
  // Codex reports a model call's tokens after the steps it produced.
  let codexCallStart = 0;
  let codexTotal = -1;
  for (const [index, line] of lines.entries()) {
    let envelope;
    try {
      envelope = record(JSON.parse(line));
    } catch {
      continue;
    }
    envelopes.push(envelope);
    const requestUsage =
      provider === "claude" &&
      envelope.type === "assistant" &&
      envelope.isSidechain !== true
        ? claudeRequestUsage(envelope)
        : undefined;
    if (provider === "codex") {
      const payload = record(envelope.payload);
      const info = record(payload.info);
      const total = record(info.total_token_usage);
      const last = record(info.last_token_usage);
      const grown =
        Number(total.input_tokens ?? 0) + Number(total.output_tokens ?? 0);
      if (
        payload.type === "token_count" &&
        last.input_tokens &&
        grown !== codexTotal
      ) {
        codexTotal = grown;
        const usage = {
          requestId: `codex:${index}`,
          inputTokens: Number(last.input_tokens) || 0,
          cacheReadTokens: Number(last.cached_input_tokens) || 0,
          cacheWriteTokens: Number(last.cache_write_input_tokens) || 0,
          outputTokens: Number(last.output_tokens) || 0,
        };
        for (const step of messages.slice(codexCallStart))
          step.requestUsage = usage;
        codexCallStart = messages.length;
      }
    }
    for (const item of adapters[provider](envelope, `line-${index}`)) {
      if (requestUsage) item.requestUsage = requestUsage;
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
  attachTurnUsage(
    messages,
    (provider === "claude" ? claudeNativeUsage : codexNativeUsage)(envelopes)
      .turns,
  );
  if (truncated)
    messages.push({
      id: "unloaded-tail",
      kind: "boundary",
      text: processLabels.transcriptTailUnloaded,
    });
  return messages;
}

/** A turn's usage goes on the answer that ended it, as live turns report it. */
function attachTurnUsage(
  messages: TranscriptMessage[],
  turns: ReturnType<typeof claudeNativeUsage>["turns"],
): void {
  for (const { startedAt, endedAt, ...usage } of turns) {
    const from = Date.parse(startedAt);
    const to = Date.parse(endedAt) + 5000;
    const answer = [...messages].reverse().find((message) => {
      const at = message.at ? Date.parse(message.at) : NaN;
      return message.kind === "assistant" && at >= from && at <= to;
    });
    if (answer) answer.turnUsage = usage;
  }
}
