/**
 * Background work an agent leaves running: commands, monitors, workflows and
 * background subagents.
 *
 * Claude Code reports it on its SDK stream (`task_started`, `task_updated`,
 * `task_notification`, `background_tasks_changed`) and lists it in the Stop
 * hook. The tracker lives as long as the agent process, not a Foundry turn:
 * a turn ends with the agent's answer while its background work continues,
 * so every message is observed, including those between turns. Each change
 * is persisted beside the session's records and published as a session event
 * whose metadata carries the snapshot (latest wins).
 *
 * The Codex SDK ends everything a turn started with the turn
 * (`codex exec --experimental-json`); it reports no background work.
 */

import {
  processLabels,
  type AgentBackgroundTask,
  type AgentBackgroundTaskOutput,
} from "@bd777/foundry-protocol";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { redactSecrets } from "./secret-redaction.js";
import type { TimerSinkEvent } from "./agent-timers.js";

export interface AgentBackgroundTasksCapability {
  readonly provider: "claude" | "codex";
  readonly supported: boolean;
}

export const claudeBackgroundTasksCapability: AgentBackgroundTasksCapability = {
  provider: "claude",
  supported: true,
};

/** Nothing a Codex turn starts outlives it, so there is nothing to show. */
export const codexBackgroundTasksCapability: AgentBackgroundTasksCapability = {
  provider: "codex",
  supported: false,
};

export const backgroundTasksSyncLabel = processLabels.backgroundTasksSync;

/** Finished tasks a session keeps; running ones are always kept. */
export const finishedBackgroundTasksKept = 20;
/** How much of a task's output a read returns: its end. */
export const backgroundOutputTailBytes = 64 * 1024;
const backgroundTasksFile = "background-tasks.json";
const commandLimit = 4000;
const summaryLimit = 600;
const toolUsesKept = 400;

/** What the device keeps of a task: the public fields plus its log. */
export interface BackgroundTaskRecord extends AgentBackgroundTask {
  outputPath?: string;
}

interface PersistedBackgroundTasks {
  version: 1;
  sessionId: string;
  /** The session's TMPDIR when recorded; task logs must lie inside it. */
  scratchDirectory?: string;
  tasks: BackgroundTaskRecord[];
}

export interface BackgroundTaskSink {
  /** Route a snapshot to the active turn or the out-of-band channel. */
  emit: (event: TimerSinkEvent) => void;
  /** Foundry session the agent process currently serves. */
  sessionId: () => string;
  /** Where the session keeps its records; undefined skips persistence. */
  sessionsRoot?: () => string | undefined;
  /** The session's scratch directory (TMPDIR), when it has one. */
  scratchDirectory?: () => string | undefined;
  now?: () => number;
}

interface ToolUse {
  name: string;
  input: Record<string, unknown>;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/** The exit code Claude's summary states, e.g. "failed with exit code 144". */
export function backgroundExitCode(summary: string): number | undefined {
  const match = /exit code (-?\d+)/i.exec(summary);
  if (!match) return undefined;
  const code = Number(match[1]);
  return Number.isSafeInteger(code) ? code : undefined;
}

function kindFor(
  taskType: string,
  toolName: string | undefined,
  hookType?: string,
): AgentBackgroundTask["kind"] {
  if (toolName === "Monitor" || hookType === "monitor") return "monitor";
  if (taskType === "local_bash" || hookType === "shell") return "command";
  if (taskType === "local_workflow" || hookType === "workflow")
    return "workflow";
  if (taskType === "local_agent" || hookType === "subagent") return "subagent";
  return "other";
}

function writesOutput(kind: AgentBackgroundTask["kind"]): boolean {
  return kind === "command" || kind === "monitor";
}

function commandOf(use: ToolUse | undefined): string | undefined {
  const command = text(use?.input.command);
  return command ? clip(redactSecrets(command), commandLimit) : undefined;
}

/** Where a backgrounded Bash call writes, as its tool result states it. */
function outputPathIn(result: string): string | undefined {
  const match = /Output is being written to: (\S+?\.output)\b/.exec(result);
  return match?.[1];
}

/** The auto-background notice states how long the task may still run. */
function backgroundLimitIn(result: string): number | undefined {
  const match =
    /still running after (\d+)\s*m(?:in(?:utes?)?)? in the background/i.exec(
      result,
    );
  return match ? Number(match[1]) * 60_000 : undefined;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      objectValue(part)?.type === "text" ? text(objectValue(part)?.text) : "",
    )
    .join("\n");
}

/** The task's public fields: what every viewer of the session may see. */
export function publicBackgroundTask(
  task: BackgroundTaskRecord,
): AgentBackgroundTask {
  const { outputPath: _outputPath, command: _command, ...rest } = task;
  return rest;
}

function byRecency(left: BackgroundTaskRecord, right: BackgroundTaskRecord) {
  return (right.endedAt ?? right.startedAt).localeCompare(
    left.endedAt ?? left.startedAt,
  );
}

/** Running tasks first, then the most recent finished ones. */
export function retainedBackgroundTasks(
  tasks: Iterable<BackgroundTaskRecord>,
): BackgroundTaskRecord[] {
  const all = [...tasks];
  const running = all.filter((task) => task.status === "running");
  const finished = all
    .filter((task) => task.status !== "running")
    .sort(byRecency)
    .slice(0, finishedBackgroundTasksKept);
  return [
    ...running.sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
    ...finished,
  ];
}

export function backgroundTasksPath(
  sessionsRoot: string,
  sessionId: string,
): string {
  return join(sessionsRoot, sessionId, backgroundTasksFile);
}

export function readPersistedBackgroundTasks(
  sessionsRoot: string,
  sessionId: string,
): PersistedBackgroundTasks | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(backgroundTasksPath(sessionsRoot, sessionId), "utf8"),
    ) as PersistedBackgroundTasks;
    return parsed && Array.isArray(parsed.tasks) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Follows one Claude agent process's background work and publishes it.
 * Foreground tool tasks (a Bash call the turn waits for) are held aside and
 * join the list only if they are moved to the background.
 */
export class ClaudeBackgroundTaskTracker {
  private readonly tasks = new Map<string, BackgroundTaskRecord>();
  private readonly foreground = new Map<string, BackgroundTaskRecord>();
  private readonly toolUses = new Map<string, ToolUse>();
  private readonly stopRequests = new Set<string>();
  private lastSignature = "";
  private closed = false;
  private loadedFor = "";

  constructor(private readonly sink: BackgroundTaskSink) {}

  private now(): number {
    return this.sink.now?.() ?? Date.now();
  }

  private iso(epochMs?: number): string {
    return new Date(epochMs ?? this.now()).toISOString();
  }

  /** Options fragment merged into the Claude SDK `query()` hooks. */
  hooks(): Record<string, unknown> {
    return {
      Stop: [
        {
          hooks: [
            async (input: unknown) => {
              this.handleStop(input);
              return undefined;
            },
          ],
        },
      ],
    };
  }

  running(): BackgroundTaskRecord[] {
    return [...this.tasks.values()].filter((task) => task.status === "running");
  }

  hasRunning(): boolean {
    return this.running().length > 0;
  }

  record(taskId: string): BackgroundTaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  snapshot(): AgentBackgroundTask[] {
    return retainedBackgroundTasks(this.tasks.values()).map(
      publicBackgroundTask,
    );
  }

  /** A stop Foundry asked for; its notification then reads "stopped by you". */
  requestStop(taskId: string): void {
    this.stopRequests.add(taskId);
  }

  /**
   * The process now serves this session. Tasks a previous process of the
   * same session left as running died with it: they read as ended by the
   * agent's exit, and the list is published again.
   */
  attach(): void {
    const sessionId = this.sink.sessionId();
    if (!sessionId || this.loadedFor === sessionId) return;
    this.loadedFor = sessionId;
    const root = this.sink.sessionsRoot?.();
    if (root) {
      const persisted = readPersistedBackgroundTasks(root, sessionId);
      for (const task of persisted?.tasks ?? []) {
        if (this.tasks.has(task.id)) continue;
        this.tasks.set(
          task.id,
          task.status === "running"
            ? {
                ...task,
                status: "stopped",
                stopReason: "agent_exit",
                endedAt: this.iso(),
              }
            : task,
        );
      }
    }
    this.changed(true);
  }

  /** The agent process is gone; its background work went with it. */
  close(): void {
    if (this.closed) return;
    for (const task of this.tasks.values()) {
      if (task.status !== "running") continue;
      task.status = "stopped";
      task.stopReason = "agent_exit";
      task.endedAt = this.iso();
    }
    this.changed();
    this.closed = true;
  }

  observe(message: unknown): void {
    if (this.closed) return;
    const record = objectValue(message);
    if (!record) return;
    if (record.type === "assistant") {
      this.observeToolUses(record);
      return;
    }
    if (record.type === "user") {
      this.observeToolResults(record);
      return;
    }
    if (record.type !== "system") return;
    switch (text(record.subtype)) {
      case "task_started":
        this.started(record);
        return;
      case "task_updated":
        this.updated(record);
        return;
      case "task_notification":
        this.notified(record);
        return;
      case "background_tasks_changed":
        this.listed(record);
        return;
      default:
        return;
    }
  }

  private observeToolUses(record: Record<string, unknown>): void {
    const content = objectValue(record.message)?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      const item = objectValue(block);
      if (item?.type !== "tool_use") continue;
      const id = text(item.id);
      if (!id) continue;
      this.toolUses.set(id, {
        name: text(item.name),
        input: objectValue(item.input) ?? {},
      });
      while (this.toolUses.size > toolUsesKept) {
        const oldest = this.toolUses.keys().next().value;
        if (oldest === undefined) break;
        this.toolUses.delete(oldest);
      }
    }
  }

  private observeToolResults(record: Record<string, unknown>): void {
    const content = objectValue(record.message)?.content;
    if (!Array.isArray(content)) return;
    const structured = objectValue(record.tool_use_result);
    let changed = false;
    for (const block of content) {
      const item = objectValue(block);
      if (item?.type !== "tool_result") continue;
      const toolUseId = text(item.tool_use_id);
      const use = this.toolUses.get(toolUseId);
      const result = toolResultText(item.content);
      if (use?.name === "Monitor") {
        const id = text(structured?.taskId);
        const task = id ? this.find(id) : this.byToolUse(toolUseId);
        if (!task) continue;
        task.kind = "monitor";
        task.hasOutput = true;
        const timeout = Number(structured?.timeoutMs);
        if (structured?.persistent !== true && timeout > 0)
          task.timeLimitMs = timeout;
        this.promote(task);
        changed = true;
        continue;
      }
      const id =
        text(structured?.backgroundTaskId) ||
        (/background with ID: ([A-Za-z0-9_-]+)/.exec(result)?.[1] ?? "") ||
        (/moved to the background \(ID: ([A-Za-z0-9_-]+)\)/.exec(result)?.[1] ??
          "");
      if (!id) continue;
      const task = this.find(id);
      if (!task) continue;
      const outputPath = outputPathIn(result);
      if (outputPath) {
        task.outputPath = outputPath;
        task.hasOutput = true;
      }
      task.timeLimitMs = backgroundLimitIn(result) ?? task.timeLimitMs;
      if (!task.command) task.command = commandOf(use);
      this.promote(task);
      changed = true;
    }
    if (changed) this.changed();
  }

  private find(taskId: string): BackgroundTaskRecord | undefined {
    return this.tasks.get(taskId) ?? this.foreground.get(taskId);
  }

  private byToolUse(toolUseId: string): BackgroundTaskRecord | undefined {
    if (!toolUseId) return undefined;
    for (const task of [...this.tasks.values(), ...this.foreground.values()])
      if (task.toolUseId === toolUseId) return task;
    return undefined;
  }

  /** A foreground task moved to the background joins the list. */
  private promote(task: BackgroundTaskRecord): void {
    if (this.foreground.get(task.id) === task) {
      this.foreground.delete(task.id);
      this.tasks.set(task.id, task);
    }
  }

  private started(record: Record<string, unknown>): void {
    const id = text(record.task_id);
    if (!id) return;
    const taskType = text(record.task_type);
    const toolUseId = text(record.tool_use_id) || undefined;
    const use = toolUseId ? this.toolUses.get(toolUseId) : undefined;
    const kind = kindFor(taskType, use?.name);
    const known = this.find(id);
    const description = clip(
      redactSecrets(
        text(record.description) ||
          text(record.workflow_name) ||
          known?.description ||
          id,
      ),
      summaryLimit,
    );
    const task: BackgroundTaskRecord = {
      ...known,
      id,
      provider: "claude",
      kind: known?.kind === "monitor" ? "monitor" : kind,
      description,
      status: known?.status ?? "running",
      startedAt: known?.startedAt ?? this.iso(),
      hasOutput: known?.hasOutput || writesOutput(kind),
      ...(toolUseId ? { toolUseId } : {}),
      ...(commandOf(use) ? { command: commandOf(use) } : {}),
    };
    if (this.tasks.has(id)) {
      this.tasks.set(id, task);
      this.changed();
      return;
    }
    // Older CLIs omit is_backgrounded; their tasks wait for the snapshot or
    // the tool result to say they run in the background. Monitors and
    // workflows always do.
    const backgrounded =
      record.is_backgrounded === true ||
      (record.is_backgrounded === undefined &&
        (kind === "monitor" || kind === "workflow" || kind === "other"));
    if (!backgrounded) {
      this.foreground.set(id, task);
      while (this.foreground.size > toolUsesKept) {
        const oldest = this.foreground.keys().next().value;
        if (oldest === undefined) break;
        this.foreground.delete(oldest);
      }
      return;
    }
    this.tasks.set(id, task);
    this.changed();
  }

  private updated(record: Record<string, unknown>): void {
    const id = text(record.task_id);
    const patch = objectValue(record.patch);
    if (!id || !patch) return;
    const task = this.find(id);
    if (!task) return;
    if (patch.is_backgrounded === true) this.promote(task);
    if (!this.tasks.has(id)) return;
    const description = text(patch.description);
    if (description)
      task.description = clip(redactSecrets(description), summaryLimit);
    const status = text(patch.status);
    if (
      task.status === "running" &&
      (status === "completed" || status === "failed" || status === "killed")
    ) {
      this.settle(
        task,
        status === "killed" ? "stopped" : status,
        typeof patch.end_time === "number" ? patch.end_time : undefined,
      );
      const error = text(patch.error);
      if (error && !task.summary)
        task.summary = clip(redactSecrets(error), summaryLimit);
    }
    this.changed();
  }

  private settle(
    task: BackgroundTaskRecord,
    status: "completed" | "failed" | "stopped",
    endedAtMs?: number,
  ): void {
    task.status = status;
    task.endedAt = task.endedAt ?? this.iso(endedAtMs);
    if (status === "stopped" && this.stopRequests.has(task.id))
      task.stopReason = "user";
  }

  private notified(record: Record<string, unknown>): void {
    const id = text(record.task_id);
    if (!id) return;
    const task = this.tasks.get(id);
    if (!task) {
      // A foreground tool finished: it was never background work.
      this.foreground.delete(id);
      return;
    }
    // The notification is the final word on how the task ended.
    const status = text(record.status);
    const summary = text(record.summary);
    this.settle(
      task,
      status === "completed"
        ? "completed"
        : status === "failed"
          ? "failed"
          : "stopped",
    );
    // A stop's summary is only the description again.
    if (
      summary &&
      summary !== text(record.description) &&
      summary !== task.description
    ) {
      task.summary = clip(redactSecrets(summary), summaryLimit);
      task.exitCode = backgroundExitCode(summary) ?? task.exitCode;
    }
    const outputFile = text(record.output_file);
    if (outputFile) {
      task.outputPath = outputFile;
      task.hasOutput = true;
    }
    this.changed();
  }

  private listed(record: Record<string, unknown>): void {
    if (!Array.isArray(record.tasks)) return;
    const listed = new Set<string>();
    for (const entry of record.tasks) {
      const item = objectValue(entry);
      const id = text(item?.task_id);
      if (!item || !id) continue;
      listed.add(id);
      const owner = text(item.parent_task_id) || undefined;
      const known = this.find(id);
      if (known) {
        this.promote(known);
        if (owner) known.ownerSubagentTaskId = owner;
        continue;
      }
      const kind = kindFor(text(item.task_type), undefined);
      this.tasks.set(id, {
        id,
        provider: "claude",
        kind,
        description: clip(
          redactSecrets(text(item.description) || id),
          summaryLimit,
        ),
        status: "running",
        startedAt: this.iso(),
        hasOutput: writesOutput(kind),
        ...(owner ? { ownerSubagentTaskId: owner } : {}),
      });
    }
    // A notification normally precedes the list without the task. Work a
    // subagent started reports its end to the subagent instead: it is gone,
    // and how it ended is unknown here.
    for (const task of this.tasks.values()) {
      if (task.status !== "running" || listed.has(task.id)) continue;
      task.status = "ended";
      task.endedAt = this.iso();
    }
    this.changed();
  }

  private handleStop(input: unknown): void {
    const hook = objectValue(input);
    if (this.closed || !hook || hook.agent_id) return;
    if (!Array.isArray(hook.background_tasks)) return;
    let changed = false;
    for (const entry of hook.background_tasks) {
      const item = objectValue(entry);
      const id = text(item?.id);
      if (!item || !id) continue;
      const hookType = text(item.type);
      const command = text(item.command);
      const known = this.find(id);
      if (known) {
        this.promote(known);
        if (hookType === "monitor") known.kind = "monitor";
        if (command && !known.command)
          known.command = clip(redactSecrets(command), commandLimit);
        changed = true;
        continue;
      }
      const kind = kindFor("", undefined, hookType);
      this.tasks.set(id, {
        id,
        provider: "claude",
        kind,
        description: clip(
          redactSecrets(text(item.description) || id),
          summaryLimit,
        ),
        status: "running",
        startedAt: this.iso(),
        hasOutput: writesOutput(kind),
        ...(command
          ? { command: clip(redactSecrets(command), commandLimit) }
          : {}),
      });
      changed = true;
    }
    if (changed) this.changed();
  }

  private prune(): void {
    const kept = new Set(retainedBackgroundTasks(this.tasks.values()));
    for (const [id, task] of this.tasks)
      if (!kept.has(task)) this.tasks.delete(id);
  }

  private changed(force = false): void {
    if (this.closed) return;
    this.prune();
    this.persist();
    const snapshot = this.snapshot();
    const signature = JSON.stringify(snapshot);
    if (!force && signature === this.lastSignature) return;
    if (snapshot.length === 0 && this.lastSignature === "") return;
    this.lastSignature = signature;
    const running = snapshot.filter((task) => task.status === "running");
    this.sink.emit({
      label: backgroundTasksSyncLabel,
      detail: running.map((task) => task.description).join("\n"),
      metadata: { backgroundTaskSnapshot: snapshot },
    });
  }

  private persist(): void {
    const root = this.sink.sessionsRoot?.();
    const sessionId = this.sink.sessionId();
    if (!root || !sessionId || this.tasks.size === 0) return;
    const path = backgroundTasksPath(root, sessionId);
    const value: PersistedBackgroundTasks = {
      version: 1,
      sessionId,
      scratchDirectory: this.sink.scratchDirectory?.(),
      tasks: retainedBackgroundTasks(this.tasks.values()),
    };
    try {
      mkdirSync(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        mode: 0o600,
      });
      renameSync(temporary, path);
    } catch (error) {
      console.warn(
        `Could not record background tasks for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

// --- Output ----------------------------------------------------------------

/** CSI, OSC and two-byte escapes, then other control characters. */
const ansiPattern =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const controlPattern = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** Terminal output as plain text; a carriage return rewrites its line. */
export function plainTerminalText(value: string): string {
  return value
    .replace(ansiPattern, "")
    .split("\n")
    .map((line) => {
      const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
      const parts = trimmed.split("\r");
      return parts[parts.length - 1] ?? "";
    })
    .join("\n")
    .replace(controlPattern, "");
}

function within(directory: string, path: string): boolean {
  const relation = relative(directory, path);
  return relation !== "" && !relation.startsWith("..") && !isAbsolute(relation);
}

/** A task log the CLI wrote under the session's TMPDIR, found by its name. */
function discoverOutputPath(
  scratch: string,
  taskId: string,
): string | undefined {
  const name = `${taskId}.output`;
  const list = (path: string): string[] => {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  };
  // <scratch>/claude-<uid>/<project>/<native session>/tasks/<task>.output
  for (const user of list(scratch).filter((entry) =>
    entry.startsWith("claude-"),
  ))
    for (const project of list(join(scratch, user)))
      for (const native of list(join(scratch, user, project))) {
        const candidate = join(scratch, user, project, native, "tasks", name);
        if (list(dirname(candidate)).includes(name)) return candidate;
      }
  return undefined;
}

/**
 * Checks that a task log is the task's own file inside the session's scratch
 * directory: `…/tasks/<taskId>.output`, a regular file, no symbolic link on
 * the way, resolving where it is named.
 */
export function verifiedTaskOutputPath(
  scratch: string,
  taskId: string,
  path: string,
): string {
  const refuse = (reason: string): never => {
    throw new Error(`This task's output is not shown: ${reason}.`);
  };
  if (!/^[A-Za-z0-9_-]+$/.test(taskId)) refuse("the task id is not valid");
  if (!isAbsolute(scratch) || !isAbsolute(path))
    refuse("its path is not absolute");
  const named = resolve(path);
  if (
    basename(named) !== `${taskId}.output` ||
    basename(dirname(named)) !== "tasks"
  )
    refuse("it is not the task's own log");
  if (!within(resolve(scratch), named))
    refuse("it is outside this chat's temporary directory");
  const link = lstatSync(named);
  if (link.isSymbolicLink() || !link.isFile())
    refuse("it is not a regular file");
  const realScratch = realpathSync(scratch);
  const expected = resolve(realScratch, relative(resolve(scratch), named));
  if (realpathSync(named) !== expected) refuse("it resolves somewhere else");
  return named;
}

function readTail(path: string, limit: number): { data: Buffer; size: number } {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile())
      throw new Error(
        "This task's output is not shown: it is not a regular file.",
      );
    const length = Math.min(limit, stat.size);
    const data = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const read = readSync(
        descriptor,
        data,
        offset,
        length - offset,
        stat.size - length + offset,
      );
      if (read <= 0) break;
      offset += read;
    }
    return { data: data.subarray(0, offset), size: stat.size };
  } finally {
    closeSync(descriptor);
  }
}

export interface BackgroundTaskOutputRequest {
  sessionId: string;
  taskId: string;
  /** The live record, when the agent process is running. */
  record?: BackgroundTaskRecord;
  /** The live process's scratch directory. */
  scratchDirectory?: string;
  /** For the persisted record when the process is gone. */
  sessionsRoot?: string;
}

/**
 * The end of a task's output: the last 64 KB as plain, redacted text. The
 * path comes from the device's own record of the task, never the request.
 */
export function readBackgroundTaskOutput(
  request: BackgroundTaskOutputRequest,
): AgentBackgroundTaskOutput {
  const persisted = request.sessionsRoot
    ? readPersistedBackgroundTasks(request.sessionsRoot, request.sessionId)
    : undefined;
  const record =
    request.record ??
    persisted?.tasks.find((task) => task.id === request.taskId);
  if (!record)
    throw new Error("This background task is not one of this chat's.");
  const base: AgentBackgroundTaskOutput = {
    sessionId: request.sessionId,
    taskId: record.id,
    ...(record.command ? { command: record.command } : {}),
    content: "",
    truncated: false,
    bytes: 0,
    kind: "missing",
  };
  const scratch = request.scratchDirectory ?? persisted?.scratchDirectory;
  if (!scratch) return base;
  const path =
    record.outputPath ??
    (writesOutput(record.kind)
      ? discoverOutputPath(scratch, record.id)
      : undefined);
  if (!path) return base;
  let verified: string;
  try {
    verified = verifiedTaskOutputPath(scratch, record.id, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return base;
    throw error;
  }
  const { data, size } = readTail(verified, backgroundOutputTailBytes);
  const truncated = size > data.length;
  if (data.subarray(0, 8192).includes(0))
    return { ...base, bytes: size, truncated, kind: "binary" };
  let content = data.toString("utf8");
  // A cut in the middle of the file: start at the first whole line.
  if (truncated) content = content.slice(content.indexOf("\n") + 1);
  return {
    ...base,
    content: redactSecrets(plainTerminalText(content)).replace(/^\n+/, ""),
    truncated,
    bytes: size,
    kind: "text",
  };
}
