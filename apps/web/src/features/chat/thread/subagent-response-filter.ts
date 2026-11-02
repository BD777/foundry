import {
  subagentResponseFingerprint,
  type AgentSessionEvent,
} from "@bd777/foundry-protocol";

/** Each response event's fingerprint, kept as long as the event. */
const fingerprints = new WeakMap<AgentSessionEvent, string>();

/**
 * Whether a response event of the main transcript (whose answer is `text`)
 * shows: it says something, and it is not a subagent's answer (its
 * fingerprint among `suppressedFingerprints`, see
 * subagentResponseFingerprint) unless it is the transcript's last answer.
 */
export function shouldDisplayResponseEvent(
  event: AgentSessionEvent,
  text: string,
  terminalResponseEventId: string | undefined,
  suppressedFingerprints: ReadonlySet<string>,
): boolean {
  if (text.trim() === "") return false;
  if (event.id === terminalResponseEventId || suppressedFingerprints.size === 0)
    return true;
  let fingerprint = fingerprints.get(event);
  if (fingerprint === undefined) {
    fingerprint = subagentResponseFingerprint(text);
    fingerprints.set(event, fingerprint);
  }
  return !suppressedFingerprints.has(fingerprint);
}
