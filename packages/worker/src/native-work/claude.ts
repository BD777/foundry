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
      status: task.status === "ended" ? "unknown" : task.status,
      at: new Date().toISOString(),
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
