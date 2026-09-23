/**
 * Per-turn watchdog for Claude active runtime sessions.
 *
 * Only has an idle timer — no max duration timer. Long-running sessions
 * that are actively producing output should not be killed; the idle timer
 * only fires when the SDK goes completely silent (no messages at all).
 */
export class ClaudeTurnWatchdog {
  private closed = false;
  private idleTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly idleTimeoutMs: number,
    private readonly onTimeout: (kind: "idle") => void,
  ) {
    this.touch();
  }

  touch(): void {
    if (this.closed) {
      return;
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(
      () => this.timeout("idle"),
      Math.max(1, this.idleTimeoutMs),
    );
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private timeout(kind: "idle"): void {
    if (this.closed) {
      return;
    }
    this.close();
    this.onTimeout(kind);
  }
}
