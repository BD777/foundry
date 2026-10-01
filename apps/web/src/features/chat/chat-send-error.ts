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

import { i18n } from "../../i18n";

interface ErrorWithStatus {
  status?: unknown;
  message?: unknown;
}

function withRetry(key: SendFailure): string {
  return i18n.t("chat:sendError.withRetry", {
    reason: i18n.t(`chat:sendError.${key}`),
  });
}

type SendFailure =
  | "unavailable"
  | "deviceRemoved"
  | "daemonOffline"
  | "deviceBusy"
  | "conflict"
  | "unauthorized"
  | "rateLimited"
  | "undelivered"
  | "unreachable";

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
      return withRetry("unavailable");
    }
    if (status === 410) {
      return withRetry("deviceRemoved");
    }
    if (status === 409) {
      if (bodyIncludes(reason, /daemon|not connected|offline/i)) {
        return withRetry("daemonOffline");
      }
      if (bodyIncludes(reason, /busy|in progress|already/i)) {
        return withRetry("deviceBusy");
      }
      return withRetry("conflict");
    }
    if (status === 401 || status === 403) {
      return withRetry("unauthorized");
    }
    if (status === 429) {
      return withRetry("rateLimited");
    }
    // 400/500/anything else: do not surface the server body (may carry
    // internal detail); collapse to one generic, actionable message.
    return withRetry("undelivered");
  }
  // No HTTP status: a thrown fetch failure means the server itself was
  // unreachable. Any other non-HTTP error gets the same safe generic copy.
  if (
    reason instanceof TypeError ||
    bodyIncludes(reason, /failed to fetch|networkerror|load failed/i)
  ) {
    return withRetry("unreachable");
  }
  return withRetry("undelivered");
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
