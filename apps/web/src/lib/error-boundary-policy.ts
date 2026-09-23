export interface ErrorBoundaryResetInput {
  failed: boolean;
  nextResetKey: string;
  previousResetKey: string;
}

/**
 * A caught render failure clears itself when the surrounding scope changes, so
 * navigating or switching workspace recovers without a manual page reload.
 */
export function shouldResetErrorBoundary({
  failed,
  nextResetKey,
  previousResetKey,
}: ErrorBoundaryResetInput): boolean {
  return failed && nextResetKey !== previousResetKey;
}

/** Keeps boundary copy useful without leaking stack traces into the UI. */
export function errorBoundaryMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : "";
  return message || "The view stopped responding.";
}

/** Failed module imports stay cached until the document is reloaded. */
export function requiresPageReload(message: string): boolean {
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Loading chunk .+ failed/i.test(
    message,
  );
}
