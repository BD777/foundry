import { i18n } from "../i18n";

/**
 * A thrown value as text: its message; without one, `fallback` when given,
 * else the value itself.
 */
export function errorText(cause: unknown, fallback?: string): string {
  if (cause instanceof Error && cause.message) return cause.message;
  if (fallback !== undefined) return fallback;
  return cause instanceof Error ? cause.message : String(cause);
}

/** A failed server call as text: its message, else "server unreachable". */
export function serverErrorText(cause: unknown): string {
  return errorText(cause, i18n.t("common:errors.serverUnreachable"));
}
