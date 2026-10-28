import type { TranscriptMessage } from "@bd777/foundry-protocol";
import type {
  ConversationToolFrame,
  StepUsage,
} from "../../components/conversation/conversation-types";
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
    | "sentBySessionId"
    | "questionItemId"
  > & {
    /**
     * This step's own identity where `id` is shared: `id` names the provider
     * item a step reports on, and a tool call's start and its result are
     * steps of one item, which a steered message can put in two groups.
     */
    stepId?: string;
    /** Screenshots this tool step produced (DEV-075). */
    frames?: ConversationToolFrame[];
  };

const processKinds = new Set<TranscriptMessage["kind"]>([
  "reasoning",
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
  // When the segment before the next group ended: the input, a steered
  // message or an answer. The group's time runs from there, so its first
  // step's wait counts and its live timer and final duration agree.
  let previousAt: string | undefined;
  const flush = () => {
    const first = pending[0];
    if (!first) return;
    const last = pending[pending.length - 1]!;
    const firstStepAt = first.at ? Date.parse(first.at) : NaN;
    const previousEndedAt = previousAt ? Date.parse(previousAt) : NaN;
    const begins =
      previousEndedAt <= firstStepAt ? previousAt : (first.at ?? previousAt);
    const startedAt = begins ? Date.parse(begins) : NaN;
    const endedAt = last.at ? Date.parse(last.at) : NaN;
    const durationMs = endedAt - startedAt;
    const usage = stepUsage(pending);
    messages.push({
      ...(durationMs > 0 ? { durationMs } : {}),
      ...(begins ? { startedAt: begins } : {}),
      ...(usage ? { stepUsage: usage } : {}),
      // Named by its first step, not that step's item: unique per row.
      id: `${first.stepId ?? first.id}:process`,
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
        ...(item.frames?.length ? { frames: item.frames } : {}),
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
    previousAt = entry.at;
    const {
      kind,
      callId: _callId,
      status: _status,
      stepId: _stepId,
      ...rest
    } = entry;
    messages.push({
      ...rest,
      role: kind === "user" ? "user" : "bot",
      kind:
        kind === "user" || kind === "assistant" || kind === "commentary"
          ? undefined
          : (kind as "boundary" | "failure"),
    });
  }
  flush();
  return messages;
}
