import { activeClaudeRuntimes } from "../session-state.js";
import { cancelActiveSession } from "../session-control.js";
import { sessionTimers } from "../session-timers.js";
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
    inspect(sessionId, sourceId) {
      const runtime = runtimeFor(sessionId);
      const task = runtime?.background?.record(sourceId);
      if (task) return task.status === "ended" ? "unknown" : task.status;
      return runtime?.background?.runsSubagent(sourceId)
        ? "running"
        : "unknown";
    },
    async stop(sessionId, sourceId) {
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
  supervisor.onActivate(() => sessionTimers.stop());
  await supervisor.start(serverURL, version);
  // There is exactly one schedule executor. Old timer persistence is retained
  // only for importing historical snapshots, never as a second firing loop.
  if (supervisor.enabled()) sessionTimers.stop();
}
