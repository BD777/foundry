import { redactSecrets } from "../platform/secret-redaction.js";
import type { WorkStatus } from "@bd777/foundry-protocol";
import {
  nativeWorkInfo,
  type NativeWorkTask,
  type NativeWorkSink,
  type NativeWorkController,
} from "./types.js";

type RPC = { request(method: string, params: unknown): Promise<any> };
type Terminal = {
  processId: string;
  itemId: string;
  command: string;
  cwd: string;
};
const terminalState = (state: WorkStatus) =>
  ["completed", "failed", "stopped"].includes(state);
const reportedMissingState = (task: NativeWorkTask) =>
  task.observation.status === "unknown" &&
  task.observation.endedAt !== undefined;
const agentStates: Record<string, WorkStatus> = {
  pendingInit: "running",
  running: "running",
  interrupted: "suspended",
  completed: "completed",
  errored: "failed",
  shutdown: "stopped",
  notFound: "unknown",
};

/** Only the owning app-server connection can enumerate/control its native terminals. */
export class CodexNativeWork implements NativeWorkController {
  private tasks = new Map<string, NativeWorkTask>();
  private terminals = new Map<string, Terminal>();
  private timer?: ReturnType<typeof setInterval>;
  private polling?: Promise<void>;
  private closed = false;
  private listAvailable = false;
  private discoveryError?: string;
  private scanned?: { startedAt: number; itemIds: Set<string> };
  inventoryError(): string | undefined {
    return this.discoveryError;
  }
  /** The item ids of the terminals the last successful inventory listed. */
  liveTerminalItemIds(): string[] {
    return this.closed || !this.listAvailable
      ? []
      : [...this.terminals.values()].map((row) => row.itemId);
  }
  /** When the last successful inventory began, and what it listed. */
  lastScan(): { startedAt: number; itemIds: Set<string> } | undefined {
    return this.scanned;
  }
  constructor(
    private readonly client: RPC,
    readonly threadId: string,
    private readonly version: string,
    private readonly sink: NativeWorkSink,
    private readonly onUnavailable: (message: string) => void = () => {},
    /** After each successful inventory, published or not. */
    private readonly onInventory: () => void = () => {},
  ) {}
  private id(row: Terminal) {
    return `${this.threadId}:terminal:${row.itemId}:${row.processId}`;
  }
  start(): void {
    void this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, 2000);
    this.timer.unref?.();
  }
  inspect(id: string): WorkStatus {
    return this.tasks.get(id)?.observation.status ?? "unknown";
  }
  canStop(id: string): boolean {
    return (
      !this.closed &&
      this.listAvailable &&
      this.terminals.has(id) &&
      this.tasks.get(id)?.native.controls.stop === "available"
    );
  }
  private publish(tasks: readonly NativeWorkTask[]) {
    if (!tasks.length) return;
    for (const task of tasks) this.tasks.set(task.id, task);
    this.sink(tasks);
  }
  private sameTask(left: NativeWorkTask, right: NativeWorkTask) {
    return (
      JSON.stringify({
        ...left,
        observation: { ...left.observation, at: "" },
      }) ===
      JSON.stringify({
        ...right,
        observation: { ...right.observation, at: "" },
      })
    );
  }
  async refresh(): Promise<void> {
    if (this.closed) return;
    if (this.polling) return this.polling;
    this.polling = this.scan()
      .catch((error) => {
        if (this.closed) return;
        this.listAvailable = false;
        const message = `Codex ${this.version} background inventory unavailable: ${redactSecrets(String(error)).slice(0, 300)}`;
        if (message !== this.discoveryError) this.onUnavailable(message);
        this.discoveryError = message;
        const changed: NativeWorkTask[] = [];
        for (const task of this.tasks.values())
          if (
            task.kind === "process" &&
            !terminalState(task.observation.status)
          ) {
            const next: NativeWorkTask = {
              ...task,
              native: {
                ...task.native,
                observation: "unavailable" as const,
                controls: { ...task.native.controls, stop: "unavailable" },
              },
              observation: {
                ...task.observation,
                status: "unknown",
                at: new Date().toISOString(),
                error: String(error),
              },
            };
            if (!this.sameTask(task, next)) changed.push(next);
          }
        this.publish(changed);
      })
      .finally(() => {
        this.polling = undefined;
      });
    return this.polling;
  }
  private async scan(): Promise<void> {
    const startedAt = Date.now();
    const next = new Map<string, Terminal>();
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const page = await this.client.request(
        "thread/backgroundTerminals/list",
        { threadId: this.threadId, limit: 100, ...(cursor ? { cursor } : {}) },
      );
      if (!Array.isArray(page.data))
        throw new Error("Unrecognized native background terminal inventory");
      for (const row of page.data) {
        if (
          typeof row.processId !== "string" ||
          typeof row.itemId !== "string" ||
          typeof row.command !== "string" ||
          typeof row.cwd !== "string"
        )
          throw new Error("Unrecognized native background terminal identity");
        next.set(this.id(row), row);
      }
      cursor =
        typeof page.nextCursor === "string" ? page.nextCursor : undefined;
      if (cursor && cursors.has(cursor))
        throw new Error("Native inventory cursor repeated");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    if (this.closed) return;
    const at = new Date().toISOString();
    this.listAvailable = true;
    this.discoveryError = undefined;
    this.terminals = next;
    this.scanned = {
      startedAt,
      itemIds: new Set([...next.values()].map((row) => row.itemId)),
    };
    const changed: NativeWorkTask[] = [];
    for (const [id, row] of next) {
      const prior = this.tasks.get(id);
      // The terminate contract is verified for this installed protocol version.
      // Unknown versions remain observable until their control contract is verified.
      const stop = this.version === "0.163.0" ? "available" : "unknown";
      const task: NativeWorkTask = {
        id,
        kind: "process",
        title: redactSecrets(row.command).slice(0, 250),
        native: nativeWorkInfo(
          "codex",
          this.version,
          this.threadId,
          row.processId,
          "thread/backgroundTerminals/list",
          stop,
        ),
        spec: { cwd: row.cwd },
        observation: {
          status: "running",
          at,
          startedAt: prior?.observation.startedAt ?? at,
        },
      };
      if (!prior || !this.sameTask(prior, task)) changed.push(task);
    }
    for (const task of this.tasks.values())
      if (
        task.kind === "process" &&
        !next.has(task.id) &&
        !terminalState(task.observation.status) &&
        !reportedMissingState(task)
      ) {
        changed.push({
          ...task,
          native: {
            ...task.native,
            controls: { ...task.native.controls, stop: "unavailable" },
          },
          observation: {
            ...task.observation,
            status: "unknown",
            at,
            endedAt: at,
            error:
              "The native terminal is no longer listed; its exit outcome is unavailable.",
          },
        });
      }
    this.publish(changed);
    // A terminal whose exit was already reported publishes nothing when it
    // drops out of the inventory; whoever waits for it ending still hears.
    this.onInventory();
  }
  async stop(id: string): Promise<void> {
    await this.refresh();
    if (!this.canStop(id))
      throw new Error(
        "Native terminal ownership or control capability is unavailable",
      );
    const row = this.terminals.get(id)!;
    await this.client.request("thread/backgroundTerminals/terminate", {
      threadId: this.threadId,
      processId: row.processId,
    });
    for (let attempt = 0; attempt < 20; attempt++) {
      await this.refresh();
      if (!this.listAvailable || this.closed)
        throw new Error(
          "Native terminal stop acknowledgement could not be verified",
        );
      if (!this.terminals.has(id)) {
        const task = this.tasks.get(id)!;
        const at = new Date().toISOString();
        this.publish([
          {
            ...task,
            observation: {
              ...task.observation,
              status: "stopped",
              at,
              endedAt: at,
              error: undefined,
            },
          },
        ]);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Native terminal termination is still pending");
  }
  observe(method: string, params: any): void {
    if (this.closed || params.threadId !== this.threadId) return;
    if (method !== "item/started" && method !== "item/completed") return;
    const item = params.item;
    if (!item) return;
    const at = new Date().toISOString();
    const changed: NativeWorkTask[] = [];
    if (item.type === "commandExecution" && method === "item/completed") {
      for (const [id, row] of this.terminals)
        if (row.itemId === item.id) {
          const task = this.tasks.get(id)!;
          if (typeof item.exitCode !== "number") continue;
          this.terminals.delete(id);
          changed.push({
            ...task,
            native: {
              ...task.native,
              controls: { ...task.native.controls, stop: "unavailable" },
            },
            observation: {
              ...task.observation,
              at,
              status: item.exitCode === 0 ? "completed" : "failed",
              endedAt: at,
              exitCode: item.exitCode,
            },
          });
        }
    }
    if (
      item.type === "collabAgentToolCall" &&
      item.senderThreadId === this.threadId
    ) {
      for (const id of item.receiverThreadIds ?? []) {
        if (typeof id !== "string" || id === this.threadId) continue;
        const sourceId = `${this.threadId}:agent:${id}`;
        if (item.tool !== "spawnAgent" && !this.tasks.has(sourceId)) continue;
        const state = agentStates[item.agentsStates?.[id]?.status] ?? "unknown";
        changed.push(this.agent(sourceId, id, item.prompt ?? id, state, at));
      }
    }
    if (
      item.type === "subAgentActivity" &&
      typeof item.agentThreadId === "string"
    ) {
      const state: WorkStatus =
        item.kind === "completed"
          ? "completed"
          : item.kind === "interrupted"
            ? "suspended"
            : "running";
      changed.push(
        this.agent(
          `${this.threadId}:agent:${item.agentThreadId}`,
          item.agentThreadId,
          item.agentPath ?? item.agentThreadId,
          state,
          at,
        ),
      );
    }
    this.publish(changed);
  }
  private agent(
    id: string,
    taskId: string,
    title: string,
    status: WorkStatus,
    at: string,
  ): NativeWorkTask {
    const prior = this.tasks.get(id);
    return {
      id,
      kind: "agent" as const,
      title: prior?.title ?? redactSecrets(title).slice(0, 250),
      native: nativeWorkInfo(
        "codex",
        this.version,
        this.threadId,
        taskId,
        "app-server agent lifecycle",
        "unavailable",
      ),
      observation: {
        status,
        at,
        startedAt: prior?.observation.startedAt ?? at,
        ...(terminalState(status) ? { endedAt: at } : {}),
      },
    };
  }
  /** Call only after the owning runtime's process-group exit has been confirmed. */
  closedAfterExit(): void {
    this.closed = true;
    clearInterval(this.timer);
    const at = new Date().toISOString();
    const changed: NativeWorkTask[] = [];
    for (const task of this.tasks.values())
      if (!terminalState(task.observation.status))
        changed.push({
          ...task,
          native: {
            ...task.native,
            observation: "unavailable",
            controls: { ...task.native.controls, stop: "unavailable" },
          },
          observation: {
            ...task.observation,
            status: "stopped",
            at,
            endedAt: at,
            error: undefined,
          },
        });
    this.publish(changed);
  }
}
