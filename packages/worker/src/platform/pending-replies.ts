export interface ReplyWait {
  /** What is waited for (a method name), passed to rejectAll. */
  label?: string;
  /** Gives up after ms, rejecting with error(); unref keeps it from holding the process. */
  timeout?: { ms: number; error: () => Error; unref?: boolean };
  /** Gives up when signal aborts, rejecting with aborted(). */
  signal?: AbortSignal;
  aborted?: () => Error;
}

export interface ReplySettlers {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/**
 * Requests sent over a line protocol (JSON-RPC over stdio, the execution
 * host's socket) that wait for the reply carrying their id. Each settles
 * once: by its reply, its timeout, its abort signal or rejectAll when the
 * link ends.
 */
export class PendingReplies<Id extends string | number = string> {
  private readonly waiting = new Map<Id, ReplySettlers & { label?: string }>();

  wait<T = unknown>(id: Id, options: ReplyWait = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        settled = true;
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        if (this.waiting.get(id) === entry) this.waiting.delete(id);
      };
      const entry = {
        label: options.label,
        resolve: (value: unknown) => {
          if (settled) return;
          finish();
          resolve(value as T);
        },
        reject: (error: Error) => {
          if (settled) return;
          finish();
          reject(error);
        },
      };
      const onAbort = () =>
        entry.reject(options.aborted?.() ?? new Error("aborted"));
      if (options.timeout) {
        const { ms, error, unref } = options.timeout;
        timer = setTimeout(() => entry.reject(error()), ms);
        if (unref) timer.unref();
      }
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.set(id, entry);
    });
  }

  /** Settles the request with id; false when none waits. */
  resolve(id: Id, value: unknown): boolean {
    const entry = this.waiting.get(id);
    entry?.resolve(value);
    return entry !== undefined;
  }

  reject(id: Id, error: Error): boolean {
    const entry = this.waiting.get(id);
    entry?.reject(error);
    return entry !== undefined;
  }

  /**
   * Stops tracking the request with id and hands back its settlers, for a
   * reply that is applied later; its timeout still runs until it settles.
   */
  take(id: Id): ReplySettlers | undefined {
    const entry = this.waiting.get(id);
    this.waiting.delete(id);
    return entry;
  }

  /** Rejects every waiting request, as when the link ends. */
  rejectAll(error: (label: string | undefined, id: Id) => Error): void {
    const entries = [...this.waiting];
    this.waiting.clear();
    for (const [id, entry] of entries) entry.reject(error(entry.label, id));
  }

  get size(): number {
    return this.waiting.size;
  }
}
