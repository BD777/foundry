import { nativeWorkController } from "../agent-runtime/work/types.js";
import { activeClaudeRuntimes } from "../session-state.js";
import { cancelActiveSession } from "../session-control.js";
import { sessionWork } from "./supervisor.js";

const scheduledRuns = new Map<string, string>();
export function trackScheduledWork(sessionId: string, workId?: string) {
  if (workId) scheduledRuns.set(sessionId, workId);
  return () => {
    if (scheduledRuns.get(sessionId) === workId)
      scheduledRuns.delete(sessionId);
  };
}
export async function startSessionWork(
  serverURL: string,
  version?: string,
): Promise<void> {
  const supervisor = sessionWork();
  const runtimeFor = (id: string) =>
    [...activeClaudeRuntimes.values()].find(
      (r) => r.foundrySessionId === id && !r.closed,
    );
  supervisor.configureRuntime({
    canStop(sessionId, sourceId, source) {
      if (source === "codex")
        return nativeWorkController(sessionId)?.canStop(sourceId) === true;
      return Boolean(runtimeFor(sessionId)?.query?.stopTask);
    },
    inspect(sessionId, sourceId, source, kind) {
      if (source === "codex")
        return nativeWorkController(sessionId)?.inspect(sourceId) ?? "unknown";
      const runtime = runtimeFor(sessionId);
      if (kind === "schedule" && runtime?.timers?.isFiring(sourceId))
        return "running";
      if (kind === "schedule")
        return runtime?.timers?.snapshot().some((task) => task.id === sourceId)
          ? "idle"
          : "unknown";
      const task = runtime?.background?.record(sourceId);
      if (task) return task.status === "ended" ? "unknown" : task.status;
      return runtime?.background?.runsSubagent(sourceId)
        ? "running"
        : "unknown";
    },
    async stop(sessionId, sourceId, source) {
      if (source === "codex") {
        const controller = nativeWorkController(sessionId);
        if (!controller)
          throw new Error("Native task controller is unavailable");
        return controller.stop(sourceId);
      }
      const runtime = runtimeFor(sessionId);
      if (!runtime?.query?.stopTask)
        throw new Error("Native task controller is unavailable");
      runtime.background?.requestStop(sourceId);
      await runtime.query.stopTask(sourceId);
    },
    async stopScheduledRun(sessionId, workId, executionSessionId) {
      const execution = executionSessionId || sessionId;
      if (execution === sessionId && scheduledRuns.get(sessionId) !== workId)
        throw new Error(
          "The running scheduled turn identity could not be verified",
        );
      await cancelActiveSession(execution);
    },
    async stopChild(sessionId) {
      await cancelActiveSession(sessionId);
    },
  });
  await supervisor.start(serverURL, version);
}
