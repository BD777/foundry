import type { TranscriptMessage } from "@bd777/foundry-protocol";
import type { StepUsage } from "../../components/conversation/conversation-types";
import type { ChatViewMessage } from "./chat-types";
import { i18n } from "../../i18n";

export type TranscriptEntry = TranscriptMessage &
  Pick<
    ChatViewMessage,
    | "attachments"
    | "at"
    | "agentLabel"
    | "runtime"
    | "streaming"
    | "statusLabel"
    | "recoverable"
    | "usage"
    | "fileReferences"
    | "turnFiles"
  >;

const processKinds = new Set<TranscriptMessage["kind"]>([
  "reasoning",
  "commentary",
  "tool",
  "context",
  "status",
]);

/**
 * Tokens of the model requests behind some steps. A request that produced
 * several steps reports its usage on each; its largest report counts once.
 */
export function stepUsage(entries: TranscriptEntry[]): StepUsage | undefined {
  const requests = new Map<
    string,
    NonNullable<TranscriptEntry["requestUsage"]>
  >();
  for (const { requestUsage: usage } of entries) {
    // A report of only zeros (as some relays send) says nothing.
    if (!usage || (usage.inputTokens === 0 && usage.outputTokens === 0))
      continue;
    const seen = requests.get(usage.requestId);
    requests.set(
      usage.requestId,
      seen
        ? {
            ...usage,
            inputTokens: Math.max(seen.inputTokens, usage.inputTokens),
            cacheReadTokens: Math.max(
              seen.cacheReadTokens,
              usage.cacheReadTokens,
            ),
            cacheWriteTokens: Math.max(
              seen.cacheWriteTokens,
              usage.cacheWriteTokens,
            ),
            outputTokens: Math.max(seen.outputTokens, usage.outputTokens),
          }
        : usage,
    );
  }
  if (requests.size === 0) return undefined;
  const total: StepUsage = {
    requests: requests.size,
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
  };
  for (const usage of requests.values()) {
    total.inputTokens += usage.inputTokens;
    total.cacheReadTokens += usage.cacheReadTokens;
    total.outputTokens += usage.outputTokens;
  }
  return total;
}

/** The only grouping policy, shared by every provider and transcript source. */
export function projectTranscript(
  entries: TranscriptEntry[],
): ChatViewMessage[] {
  const messages: ChatViewMessage[] = [];
  let pending: TranscriptEntry[] = [];
  const flush = () => {
    const first = pending[0];
    if (!first) return;
    const last = pending[pending.length - 1]!;
    const startedAt = first.at ? Date.parse(first.at) : NaN;
    const endedAt = last.at ? Date.parse(last.at) : NaN;
    const durationMs = endedAt - startedAt;
    const usage = stepUsage(pending);
    messages.push({
      ...(durationMs > 0 ? { durationMs } : {}),
      ...(first.at ? { startedAt: first.at } : {}),
      ...(usage ? { stepUsage: usage } : {}),
      id: `${first.id}:process`,
      kind: "process",
      role: "bot",
      streaming: last.streaming,
      title: last.streaming
        ? (last.title ?? i18n.t("chat:transcript.processing"))
        : i18n.t("chat:transcript.processed"),
      text: pending.map((item) => item.text).join("\n\n"),
      processItems: pending.map((item) => ({
        id: item.id,
        kind: item.kind,
        callId: item.callId,
        status: item.status,
        title:
          item.title ??
          (item.kind === "reasoning"
            ? i18n.t("chat:transcript.reasoning")
            : item.kind === "tool"
              ? i18n.t("chat:transcript.tool")
              : i18n.t("chat:transcript.commentary")),
        detail: item.text,
      })),
    });
    pending = [];
  };
  for (const entry of entries) {
    if (processKinds.has(entry.kind)) {
      pending.push(entry);
      continue;
    }
    flush();
    const { kind, callId: _callId, status: _status, ...rest } = entry;
    messages.push({
      ...rest,
      role: kind === "user" ? "user" : "bot",
      kind:
        kind === "user" || kind === "assistant"
          ? undefined
          : (kind as "boundary" | "failure"),
    });
  }
  flush();
  return messages;
}
