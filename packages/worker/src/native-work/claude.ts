import type {
  AgentBackgroundTask,
  AgentScheduledTask,
} from "@bd777/foundry-protocol";
import { nativeWorkInfo, type NativeWorkTask } from "./types.js";

export interface ClaudeWorkContext {
  sessionId: string;
  version: string;
  canStop: (taskId: string) => boolean;
}
export function claudeBackgroundWork(
  task: AgentBackgroundTask,
  context: ClaudeWorkContext,
): NativeWorkTask {
  const kind = task.kind === "subagent" ? "agent" : "process";
  // Claude's "ended" means the task disappeared without a notification.
  // Its end is still known, so it belongs in history rather than live work.
  const status = task.status === "ended" ? "stopped" : task.status;
  return {
    id: task.id,
    kind,
    title: task.description,
    native: nativeWorkInfo(
      "claude",
      context.version,
      context.sessionId,
      task.id,
      "SDK task lifecycle",
      kind === "process" && context.canStop(task.id)
        ? "available"
        : "unavailable",
    ),
    observation: {
      status,
      at: task.endedAt ?? new Date().toISOString(),
      startedAt: task.startedAt,
      endedAt: task.endedAt,
      exitCode: task.exitCode,
    },
  };
}
export function claudeScheduledWork(
  task: AgentScheduledTask,
  context: ClaudeWorkContext,
): NativeWorkTask {
  return {
    id: task.id,
    kind: "schedule",
    title: task.prompt.split("\n")[0]!.slice(0, 250),
    native: nativeWorkInfo(
      "claude",
      context.version,
      context.sessionId,
      task.id,
      "SDK session_crons / PostToolUse",
    ),
    spec: {
      schedule: task.schedule,
      recurring: task.recurring,
      prompt: task.prompt,
    },
    observation: {
      status: "idle",
      at: new Date().toISOString(),
      nextFireAt: task.nextFireAt,
    },
  };
}
