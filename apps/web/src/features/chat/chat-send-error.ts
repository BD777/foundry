/**
 * Maps a failed chat send to a safe, actionable user-facing error.
 *
 * The create-session HTTP call can fail for distinct reasons (the picked
 * agent/connection vanished, the daemon is offline, the device was removed,
 * the server is unreachable). The composer must show that specific cause and
 * keep the draft/attachments, but it must never render an arbitrary 500
 * body, stack trace or credential-bearing server string. Status-code mapping
 * supplies fixed copy; unknown/5xx failures collapse to one generic message.
 */

interface ErrorWithStatus {
  status?: unknown;
  message?: unknown;
}

const RETRY =
  "Your message and attachments were kept — fix the issue and retry.";

function hasStatus(reason: unknown): reason is ErrorWithStatus {
  return (
    typeof reason === "object" &&
    reason !== null &&
    typeof (reason as ErrorWithStatus).status === "number"
  );
}

function bodyIncludes(reason: unknown, pattern: RegExp): boolean {
  if (typeof reason !== "object" || reason === null) return false;
  const message = (reason as ErrorWithStatus).message;
  return typeof message === "string" && pattern.test(message);
}

/** Safe fixed copy per failure class; never returns raw server text. */
export function chatSendFailureMessage(reason: unknown): string {
  if (hasStatus(reason)) {
    const status = reason.status as number;
    if (status === 404) {
      return `This agent or server connection is no longer available. Pick another agent and retry. ${RETRY}`;
    }
    if (status === 410) {
      return `This device was removed from Foundry. Re-pair the device before sending. ${RETRY}`;
    }
    if (status === 409) {
      if (bodyIncludes(reason, /daemon|not connected|offline/i)) {
        return `The local daemon is not connected. Reconnect it and retry. ${RETRY}`;
      }
      if (bodyIncludes(reason, /busy|in progress|already/i)) {
        return `The device is busy with another action. Wait for it to finish and retry. ${RETRY}`;
      }
      return `The send conflicts with the current device state. Check the connection and retry. ${RETRY}`;
    }
    if (status === 401 || status === 403) {
      return `This agent is not authorized for this workspace. Pick an authorized agent and retry. ${RETRY}`;
    }
    if (status === 429) {
      return `The model server is rate-limiting requests. Wait a moment and retry. ${RETRY}`;
    }
    // 400/500/anything else: do not surface the server body (may carry
    // internal detail); collapse to one generic, actionable message.
    return `The message could not be delivered. Check that the local Foundry server and daemon are running, then retry. ${RETRY}`;
  }
  // No HTTP status: a thrown fetch failure means the server itself was
  // unreachable. Any other non-HTTP error gets the same safe generic copy.
  if (
    reason instanceof TypeError ||
    bodyIncludes(reason, /failed to fetch|networkerror|load failed/i)
  ) {
    return `Cannot reach the local Foundry server. Check that it is running, then retry. ${RETRY}`;
  }
  return `The message could not be delivered. Check that the local Foundry server and daemon are running, then retry. ${RETRY}`;
}

/** Always returns an Error instance so the composer Alert can render it. */
export function toChatSendError(reason: unknown): Error {
  if (reason instanceof Error) {
    const mapped = chatSendFailureMessage(reason);
    const error = new Error(mapped);
    error.name = "ChatSendError";
    return error;
  }
  const error = new Error(chatSendFailureMessage(reason));
  error.name = "ChatSendError";
  return error;
}
