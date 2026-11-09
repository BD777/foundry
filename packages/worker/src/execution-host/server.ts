/** OS-managed execution service. No provider or session credential is persisted. */
import { createServer, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { chmodSync, readFileSync, unlinkSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { daemonMessageTypes } from "@bd777/foundry-protocol";
import { startServerMcpForwarder } from "../platform/server-link/server-mcp-forwarder.js";
import { foundryStatePath } from "../platform/state-root.js";
import { collectSkillSnapshotGarbage } from "../skills/skill-snapshots.js";
import { reapPrivateInputOwners } from "../platform/process/private-input-owners.js";
import {
  hasLiveAgentProcesses,
  processIdentity,
  superviseAgentProcesses,
} from "../platform/process/agent-processes.js";
import { issueEnvironmentAction } from "../issue/issue-environment-rpc.js";
import { evidenceWorkerAction } from "../issue/evidence/evidence-rpc.js";
import { onIssueEnvironmentChange } from "../candidate-store/issue-environment-changes.js";
import { readAgentRuntimeSettings } from "../device/device.js";
import { reapConnectorLeftovers } from "../connectors/index.js";
import { reapSessionTools } from "../skills/session-tools.js";
import { clearClaudeSettingsFiles } from "../session/session-launch-options.js";
import { outOfBandEventSink } from "../daemon/session-execution.js";
import { ControlOutcomeUnknownError } from "../session/session-control.js";
import {
  activeClaudeRuntimes,
  setOutOfBandSessionEventSink,
  setSessionTurnSink,
} from "../session/session-state.js";
import {
  sessionHasRunningBackgroundTasks,
  closeAllActiveRuntimes,
  startIdleRuntimeSweeps,
  claudeRuntimeIsBusy,
  stopClaudeBackgroundTask,
  controlCodexGoal,
} from "../session/runner/active-runtimes.js";
import { ConcurrentTaskScheduler } from "../platform/task-scheduler.js";
import { writePrivateJSONAtomic } from "../platform/storage.js";
import { keepSessionTimers } from "../session/tasks/session-timers.js";
import {
  setTimerRevivalPaused,
  startTimerRevival,
} from "../session/tasks/timer-revival.js";
import { configureSessionTokens } from "../session/session-token.js";
import { startSessionWork } from "../daemon/session-work-runtime.js";
import { ownPackage } from "../install/worker-identity.js";
import { sessionWork, sessionWorkBusy } from "../session-work/supervisor.js";
import { HostExecutions } from "./executions.js";
import { executionHostPaths } from "./paths.js";
import { startHostLiveness } from "./liveness.js";
import { startTurnFilesThread } from "../session/files/session-files-thread.js";
import {
  executionHostProtocol,
  type HostAck,
  type HostHandshake,
  type HostMethod,
  type HostMethods,
  type HostPush,
  type HostReply,
  type HostRequest,
  type HostSnapshot,
} from "./protocol.js";
import { prepareExecutionSocket, runtimeStamp } from "./service.js";
import { errorMessage } from "../platform/utils.js";

type HostHandlers = {
  [M in HostMethod]: (
    request: HostRequest<M>,
  ) => HostMethods[M]["result"] | Promise<HostMethods[M]["result"]>;
};

/** Answered while the host drains for a switch, and not counted as work. */
const controlMethods = new Set<HostMethod>([
  "snapshot",
  "prepare_upgrade",
  "cancel_upgrade",
]);

export async function serveExecutionHost(serverURL: string): Promise<void> {
  await startServerMcpForwarder(serverURL);
  const paths = executionHostPaths();
  prepareExecutionSocket();
  const entry = fileURLToPath(new URL("./main.js", import.meta.url));
  const stamp = runtimeStamp(entry);
  writePrivateJSONAtomic(resolve(paths.root, "identity.json"), {
    pid: process.pid,
    startTime: processIdentity(process.pid)?.startTime,
    entry,
    runtimeStamp: stamp,
    serverURL,
  });
  void startHostLiveness(paths.root, paths.label);
  startTurnFilesThread();
  const token = readFileSync(paths.token, "utf8").trim();
  const scheduler = new ConcurrentTaskScheduler(
    readAgentRuntimeSettings().maxConcurrentTasks,
  );
  const executions = new HostExecutions({
    root: paths.root,
    serverURL,
    scheduler,
    changed: () => announce(),
    failed: (error) => {
      console.error(error);
      process.exitCode = 1;
      closeAllActiveRuntimes();
      server.close();
    },
  });
  const transport = executions.transport;
  // Linux's cgroup and macOS's guardians/reaper clean the previous owner
  // before new work is accepted. Never silently rerun its interrupted work.
  await superviseAgentProcesses();
  executions.reportInterrupted();
  reapConnectorLeftovers(console.error);
  reapSessionTools(console.error);
  clearClaudeSettingsFiles();
  keepSessionTimers();
  startTimerRevival(serverURL);
  configureSessionTokens(serverURL);
  // The first work sweep reads every session's native records and asks the
  // server; on a busy device it took 106 s. The runner answers the daemon
  // meanwhile instead of looking dead to a switch (DEV-072).
  void startSessionWork(serverURL, ownPackage().version).catch((error) =>
    console.error(`Session work start: ${errorMessage(error)}`),
  );
  startIdleRuntimeSweeps();
  onIssueEnvironmentChange((change) =>
    transport.send(daemonMessageTypes.issueEnvironmentChanged, change),
  );
  setOutOfBandSessionEventSink(outOfBandEventSink(transport));
  setSessionTurnSink((sessionId, running) =>
    transport.send(daemonMessageTypes.sessionTurn, { sessionId, running }),
  );
  let owner: HostHandshake["owner"] | undefined;
  let connection: Socket | undefined;
  let operations = 0;
  let draining = false;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  const busy = () =>
    operations > 0 ||
    executions.core.scheduled() > 0 ||
    sessionWorkBusy() ||
    executions.active().length > 0 ||
    [...activeClaudeRuntimes.values()].some(claudeRuntimeIsBusy);
  // A switch at a turn boundary: no turn, background task or managed
  // service runs. Timers are handed over as the runtimes close.
  const atTurnBoundary = () =>
    operations === 0 &&
    executions.core.scheduled() === 0 &&
    !sessionWorkBusy() &&
    executions.active().length === 0 &&
    ![...activeClaudeRuntimes.values()].some(
      (runtime) =>
        !runtime.closed &&
        (runtime.pending !== undefined ||
          runtime.continuation !== undefined ||
          Boolean(runtime.background?.hasRunning())),
    );
  const cancelUpgrade = () => {
    if (!draining) return;
    draining = false;
    sessionWork().setDraining(false);
    setTimerRevivalPaused(false);
    clearTimeout(drainTimer);
  };
  const write = (socket: Socket, value: HostReply | HostPush) =>
    socket.write(`${JSON.stringify(value)}\n`);
  const snapshot = (): HostSnapshot => ({
    protocol: executionHostProtocol,
    version: ownPackage().version,
    entry,
    runtimeStamp: stamp,
    busy: busy(),
    draining,
    serverURL,
    pid: process.pid,
    startTime: processIdentity(process.pid)?.startTime,
    claims: executions.active(),
    ownTurns: [...activeClaudeRuntimes.values()].flatMap((runtime) =>
      runtime.ownTurnSessionId ? [runtime.ownTurnSessionId] : [],
    ),
    background: [...activeClaudeRuntimes.values()]
      .filter((runtime) =>
        sessionHasRunningBackgroundTasks(runtime.foundrySessionId),
      )
      .map((runtime) => runtime.foundrySessionId),
  });
  let nextInputSweep = Date.now() + 60_000;
  const sweepInputs = () => {
    if (Date.now() < nextInputSweep || busy() || hasLiveAgentProcesses())
      return;
    nextInputSweep = Date.now() + 60 * 60 * 1000;
    for (const runtime of ["codex", "claude"])
      reapPrivateInputOwners(
        foundryStatePath("native-runtime", "owners", runtime),
        "native-config",
        { currentOwnerIdle: true, minAgeMs: 60 * 60 * 1000 },
      );
    reapPrivateInputOwners(
      foundryStatePath("native-operation-data"),
      "native-operation-data",
    );
    collectSkillSnapshotGarbage({ idle: true });
  };
  const announce = () => {
    if (connection) write(connection, { type: "snapshot", ...snapshot() });
    sweepInputs();
  };
  const ticker = setInterval(announce, 5000);
  ticker.unref();
  const handlers: HostHandlers = {
    snapshot,
    prepare_upgrade: ({ mode }) => {
      const ready =
        mode === "now" || (mode === "boundary" ? atTurnBoundary() : !busy());
      if (ready) {
        draining = true;
        sessionWork().setDraining(true);
        // The next runner delivers the timers these runtimes hand over.
        setTimerRevivalPaused(true);
        closeAllActiveRuntimes();
        clearTimeout(drainTimer);
        // A lost upgrading worker must not leave the service frozen.
        drainTimer = setTimeout(cancelUpgrade, 30_000);
        drainTimer.unref();
      }
      return { ready };
    },
    cancel_upgrade: () => {
      cancelUpgrade();
      return {};
    },
    run: (request) => {
      scheduler.setMaxConcurrentTasks(
        readAgentRuntimeSettings().maxConcurrentTasks,
      );
      return executions.run(request);
    },
    steer: (request) => executions.steer(request),
    cancel: (request) => executions.cancel(request),
    stop_background: async ({ sessionId, taskId }) => {
      await stopClaudeBackgroundTask(sessionId, taskId);
      return {};
    },
    control_goal: async ({ sessionId, action }) => {
      await controlCodexGoal(sessionId, action);
      return {};
    },
    issue_environment: ({ payload }) =>
      payload.action === "preview_start"
        ? executions.core.preview(payload)
        : issueEnvironmentAction(payload),
    evidence: ({ payload }) => evidenceWorkerAction(payload),
  };
  /** The worker's first line: only the device's live worker may own the host. */
  const authenticate = (socket: Socket, handshake: HostHandshake) => {
    const supplied = Buffer.from(String(handshake.token ?? ""));
    if (
      supplied.length !== Buffer.byteLength(token) ||
      !timingSafeEqual(supplied, Buffer.from(token))
    )
      throw new Error("Execution host authentication failed");
    const identity = processIdentity(handshake.owner?.pid);
    if (!identity || identity.startTime !== handshake.owner?.startTime)
      throw new Error("Worker identity no longer exists");
    if (
      owner &&
      (owner.pid !== handshake.owner.pid ||
        owner.startTime !== handshake.owner.startTime) &&
      processIdentity(owner.pid)?.startTime === owner.startTime
    )
      throw new Error("Another live worker owns the execution host");
    owner = handshake.owner;
    writePrivateJSONAtomic(resolve(paths.root, "owner.json"), owner);
    connection?.destroy();
    connection = socket;
  };
  const server = createServer((socket) => {
    let authenticated = false;
    const authDeadline = setTimeout(() => socket.destroy(), 5000);
    const relay = {
      readyState: 1,
      get bufferedAmount() {
        return socket.writableLength;
      },
      send(data: string, callback?: (error?: Error) => void) {
        write(socket, { type: "envelope", envelope: JSON.parse(data) });
        callback?.();
      },
    };
    const lines = createInterface({ input: socket });
    lines.on("error", () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      clearTimeout(authDeadline);
      lines.close();
      transport.unbind(relay);
      if (connection === socket) connection = undefined;
    });
    lines.on("line", (line) => {
      void (async () => {
        let id: string | undefined;
        let operation = false;
        try {
          if (line.length > 16 * 1024 * 1024)
            throw new Error("Execution control message too large");
          const message = JSON.parse(line);
          id = message.id;
          if (!authenticated) {
            authenticate(socket, message as HostHandshake);
            authenticated = true;
            clearTimeout(authDeadline);
            write(socket, { id, result: snapshot() });
            transport.bind(relay);
            return;
          }
          if (connection !== socket)
            throw new Error("This worker connection has been replaced");
          if (message.method === "ack") {
            transport.acknowledge((message as HostAck).envelopeId);
            return;
          }
          const request = message as HostRequest;
          const handler = handlers[request.method] as
            ((request: HostRequest) => unknown) | undefined;
          if (!handler) throw new Error("Unsupported execution host command");
          if (!controlMethods.has(request.method)) {
            if (draining)
              throw new Error(
                "Execution service is upgrading; this request was not accepted.",
              );
            operations++;
            operation = true;
          }
          write(socket, { id, result: await handler(request) });
        } catch (error) {
          write(socket, {
            id,
            error: errorMessage(error),
            outcomeUnknown: error instanceof ControlOutcomeUnknownError,
          });
          if (!authenticated) socket.end();
        } finally {
          if (operation) operations--;
        }
      })();
    });
  });
  try {
    unlinkSync(paths.socket);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(paths.socket, () => {
      chmodSync(paths.socket, 0o600);
      done();
    });
  });
}
