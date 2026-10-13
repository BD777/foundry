// Decoding what the event stream delivers: message ids and frames.

import {
  browserStreamControlTypes,
  isBrowserEventType,
  parseProtocolEnvelopeJSON,
  type BrowserEvent,
} from "@bd777/foundry-protocol";

/**
 * What a stream message says: events may have been missed (`resync`), or an
 * event with a payload. Undefined: nothing to apply (stream_ready, names this
 * client does not know, an event without payload, malformed data; a later
 * persisted snapshot repairs malformed or interrupted stream data).
 */
export type StreamFrame =
  { kind: "resync" } | { kind: "event"; event: BrowserEvent };

export function decodeStreamFrame(data: string): StreamFrame | undefined {
  let envelope: ReturnType<typeof parseProtocolEnvelopeJSON>;
  try {
    envelope = parseProtocolEnvelopeJSON(data);
  } catch {
    return undefined;
  }
  if (envelope.type === browserStreamControlTypes.resync)
    return { kind: "resync" };
  if (!isBrowserEventType(envelope.type)) return undefined;
  const event = envelope as BrowserEvent;
  return event.payload ? { kind: "event", event } : undefined;
}

/** A stream message id: `<epoch>-<seq>` (the server's process and order). */
function parseEventId(id: string): { epoch: string; seq: number } | undefined {
  const at = id.lastIndexOf("-");
  if (at <= 0) return undefined;
  const seq = Number(id.slice(at + 1));
  return Number.isSafeInteger(seq)
    ? { epoch: id.slice(0, at), seq }
    : undefined;
}

/**
 * Whether `id` comes after `last`: a later message of the same server
 * process, or one of another (it restarted, and says resync). Ids it
 * cannot order are new.
 */
export function isNewEventId(last: string, id: string): boolean {
  const before = parseEventId(last);
  const next = parseEventId(id);
  if (!before || !next || before.epoch !== next.epoch) return true;
  return next.seq > before.seq;
}

export function newerEventId(last: string, id: string): string {
  if (!id) return last;
  return isNewEventId(last, id) ? id : last;
}
