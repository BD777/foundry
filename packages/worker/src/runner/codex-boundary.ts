/**
 * A Codex turn's boundary messages (DEV-057). Codex preempts the response
 * it is generating for any input steered into the turn, so a message from
 * another session that can wait is held until the model waits on a tool:
 * steered then, Codex reads it with the tool's result, in the next model
 * request, and loses no reasoning. A message held past its limit goes in
 * anyway; one still held when the turn ends was not delivered, and the
 * server starts the next turn with it.
 */

/** Item types during which the model waits on a tool, not generating. */
const toolItemTypes = new Set([
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "web_search",
  "dynamicToolCall",
  "collabAgentToolCall",
  "imageGeneration",
]);

/** How long a tool runs before its response has surely finished streaming. */
export const boundarySettleMs = 1_000;

export interface HeldSteer {
  apply: () => Promise<void>;
  steerId?: string;
  limitMs: number;
}

export class CodexBoundaryHold {
  private held: Array<HeldSteer & { timer: ReturnType<typeof setTimeout> }> =
    [];
  private running = new Set<string>();
  private settle?: ReturnType<typeof setTimeout>;
  private closed = false;
  private flushing: Promise<void> = Promise.resolve();

  constructor(
    private readonly onError: (error: unknown, steer: HeldSteer) => void,
    private readonly settleMs = boundarySettleMs,
  ) {}

  /** Holds steer until the turn's next tool, or its limit. */
  hold(steer: HeldSteer): void {
    if (this.closed) throw new Error("The turn has ended.");
    const entry = {
      ...steer,
      timer: setTimeout(
        () => this.deliver([entry]),
        Math.max(0, steer.limitMs),
      ),
    };
    entry.timer.unref?.();
    this.held.push(entry);
    if (this.running.size > 0) this.scheduleFlush();
  }

  /** Follows the turn's events: a tool that starts opens the boundary. */
  observe(event: unknown): void {
    if (!event || typeof event !== "object") return;
    const record = event as {
      type?: unknown;
      item?: { id?: unknown; type?: unknown };
    };
    const item = record.item;
    if (!item || typeof item.type !== "string" || !toolItemTypes.has(item.type))
      return;
    const id = String(item.id ?? "");
    if (record.type === "item.started") {
      this.running.add(id);
      this.scheduleFlush();
    } else if (record.type === "item.completed") {
      this.running.delete(id);
      // A tool done before its response settled: its next request starts
      // now, the earliest point left in the turn.
      if (this.held.length > 0 && this.settle) {
        clearTimeout(this.settle);
        this.settle = undefined;
        this.flush();
      }
    }
  }

  /** Ids still held, which the turn did not take. */
  pendingIds(): string[] {
    return this.held.flatMap((entry) => (entry.steerId ? [entry.steerId] : []));
  }

  /** The turn ended: nothing more is delivered by it. */
  close(): void {
    this.closed = true;
    if (this.settle) clearTimeout(this.settle);
    for (const entry of this.held) clearTimeout(entry.timer);
    this.held = [];
  }

  /** Waits for the deliveries started so far. */
  settled(): Promise<void> {
    return this.flushing;
  }

  private scheduleFlush(): void {
    if (this.settle || this.held.length === 0) return;
    this.settle = setTimeout(() => {
      this.settle = undefined;
      if (this.running.size > 0) this.flush();
    }, this.settleMs);
    this.settle.unref?.();
  }

  private flush(): void {
    this.deliver([...this.held]);
  }

  private deliver(entries: typeof this.held): void {
    const due = entries.filter((entry) => this.held.includes(entry));
    if (due.length === 0 || this.closed) return;
    this.held = this.held.filter((entry) => !due.includes(entry));
    for (const entry of due) clearTimeout(entry.timer);
    this.flushing = this.flushing.then(async () => {
      for (const entry of due) {
        if (this.closed) return;
        try {
          await entry.apply();
        } catch (error) {
          this.onError(error, entry);
        }
      }
    });
  }
}
