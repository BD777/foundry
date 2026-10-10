import type { ChatAttachment } from "@bd777/foundry-protocol";
import type { ChatViewMessage } from "./chat-types";

/**
 * A message this tab sent, under the one client id it carries everywhere:
 * the Idempotency-Key of its request, its queue item id, and (where the
 * server takes it) its input id. `pending` while its request runs (the
 * composer still shows it), `accepted` once the server has it (the
 * transcript shows it until its own event arrives).
 */
export interface OutboxEntry {
  id: string;
  /** The chat it went to; unknown for a new chat until accepted. */
  threadId?: string;
  sessionId?: string;
  /** The server's id of the input, once known (a queue item's is its id). */
  inputId?: string;
  text: string;
  attachments?: ChatAttachment[];
  /** When it was sent (ISO). */
  at: string;
  state: "pending" | "accepted";
}

/** A transcript message may be this entry's own event from a little earlier. */
const clockSkewMs = 60_000;

function transcriptId(entry: OutboxEntry): string | undefined {
  return entry.sessionId && entry.inputId
    ? `agent-session:${entry.sessionId}:${entry.inputId}`
    : undefined;
}

function matches(entry: OutboxEntry, message: ChatViewMessage): boolean {
  const id = transcriptId(entry);
  if (id) return message.id === id;
  if (
    entry.sessionId &&
    !message.id?.startsWith(`agent-session:${entry.sessionId}:`)
  )
    return false;
  const at = Date.parse(message.at ?? "");
  return (
    typeof message.text === "string" &&
    message.text.trim() === entry.text.trim() &&
    (!Number.isFinite(at) || at >= Date.parse(entry.at) - clockSkewMs)
  );
}

export interface OutboxProjection {
  messages: ChatViewMessage[];
  /** Entries whose own event the transcript shows. */
  delivered: ReadonlySet<string>;
}

/**
 * The transcript with this tab's messages in it: an entry whose event the
 * transcript has marks that message with its client id; an accepted entry
 * without one yet is shown at the end, under the id its event will have, so
 * it turns into that event in place. Once shown, a message never disappears.
 */
export function withOutbox(
  messages: ChatViewMessage[],
  entries: readonly OutboxEntry[],
  threadId: string | undefined,
): OutboxProjection {
  const delivered = new Set<string>();
  if (entries.length === 0) return { messages, delivered };
  const earliest = Math.min(...entries.map((entry) => Date.parse(entry.at)));
  const tagged = new Map<number, string>();
  // Newest first: a message sent twice matches its latest copies.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const at = Date.parse(message.at ?? "");
    if (Number.isFinite(at) && at < earliest - clockSkewMs) break;
    if (message.role !== "user") continue;
    const entry = entries.find(
      (candidate) =>
        !delivered.has(candidate.id) && matches(candidate, message),
    );
    if (!entry) continue;
    delivered.add(entry.id);
    tagged.set(index, entry.id);
  }
  const shown = new Set(messages.map((message) => message.id));
  const waiting = entries.filter(
    (entry) =>
      entry.state === "accepted" &&
      !delivered.has(entry.id) &&
      entry.threadId !== undefined &&
      entry.threadId === threadId &&
      !shown.has(transcriptId(entry) ?? ""),
  );
  if (tagged.size === 0 && waiting.length === 0) return { messages, delivered };
  const result = messages.map((message, index) => {
    const clientId = tagged.get(index);
    return clientId ? { ...message, clientId } : message;
  });
  for (const entry of waiting) {
    result.push({
      attachments: entry.attachments ?? [],
      at: entry.at,
      clientId: entry.id,
      id: transcriptId(entry) ?? `outbox:${entry.id}`,
      role: "user",
      text: entry.text,
    });
  }
  return { messages: result, delivered };
}
