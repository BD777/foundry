import type { TranscriptMessage } from "@foundry/protocol";
import type { ChatViewMessage } from "./chat-types";

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
  >;

const processKinds = new Set<TranscriptMessage["kind"]>([
  "reasoning",
  "commentary",
  "tool",
  "context",
  "status",
]);

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
    messages.push({
      id: `${first.id}:process`,
      kind: "process",
      role: "bot",
      streaming: last.streaming,
      title: last.streaming ? (last.title ?? "处理中") : "已处理",
      text: pending.map((item) => item.text).join("\n\n"),
      processItems: pending.map((item) => ({
        id: item.id,
        kind: item.kind,
        callId: item.callId,
        status: item.status,
        title:
          item.title ??
          (item.kind === "reasoning"
            ? "思考摘要"
            : item.kind === "tool"
              ? "工具"
              : "过程"),
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
