import { issueEnvironmentAction } from "../issue-environment-rpc.js";
import { evidenceWorkerAction } from "../evidence-rpc.js";
import { queuePreview, runIssuePreview } from "../issue-preview.js";
import { onIssueEnvironmentChange } from "../issue-environment-changes.js";
/** OS-managed execution service. No provider or session credential is persisted. */
import { createServer, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { chmodSync, readFileSync, unlinkSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  daemonMessageTypes,
  type RunSessionPayload,
} from "@bd777/foundry-protocol";
import {
  processIdentity,
  superviseAgentProcesses,
} from "../agent-processes.js";
import { readAgentRuntimeSettings } from "../device.js";
import { reapConnectorLeftovers } from "../connectors/index.js";
import { clearClaudeSettingsFiles } from "../session-policy.js";
import { runAgentSession } from "../daemon/session-run.js";
import { runDispatchedIssue } from "../daemon/issue-run.js";
import { outOfBandEventSink } from "../daemon/session-execution.js";
import {
  ControlOutcomeUnknownError,
  cancelActiveSession,
  noteSessionInput,
  steerActiveSessionOnce,
} from "../session-control.js";
import {
  dispatchKey,
  activeClaudeRuntimes,
  setOutOfBandSessionEventSink,
  setSessionTurnSink,
} from "../session-state.js";
import {
  sessionHasRunningBackgroundTasks,
  closeAllActiveRuntimes,
  stopClaudeBackgroundTask,
} from "../runner/active-runtimes.js";
import { ConcurrentTaskScheduler } from "../task-scheduler.js";
import { FileSessionOutbox } from "../session-outbox-store.js";
import { ReliableSessionTransport } from "../transport.js";
import { writePrivateJSONAtomic } from "../storage.js";
import { startSessionTimers, sessionTimers } from "../session-timers.js";
import { executionHostPaths } from "./paths.js";

interface Claim {
  sessionId: string;
  inputId: string;
  status: "active" | "completed";
}
export async function serveExecutionHost(serverURL: string): Promise<void> {
  const paths = executionHostPaths();
  writePrivateJSONAtomic(resolve(paths.root, "identity.json"), {
    pid: process.pid,
    startTime: processIdentity(process.pid)?.startTime,
    entry: fileURLToPath(new URL("./main.js", import.meta.url)),
    serverURL,
  });
  const token = readFileSync(paths.token, "utf8").trim();
  const claimsPath = resolve(paths.root, "claims.json");
  let claims: Record<string, Claim> = {};
  try {
    claims = JSON.parse(readFileSync(claimsPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const controlsPath = resolve(paths.root, "controls.json");
  const controls: Record<string, "pending" | "accepted" | "unknown"> = (() => {
    try {
      return JSON.parse(readFileSync(controlsPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  })();
  const controlFlights = new Map<string, Promise<void>>();
  const persistControls = () => writePrivateJSONAtomic(controlsPath, controls);
  const persistClaims = () => writePrivateJSONAtomic(claimsPath, claims);
  const transport = new ReliableSessionTransport({
    store: new FileSessionOutbox(resolve(paths.root, "outbox")),
    onEnqueued: (envelope) => {
      if (envelope.type !== daemonMessageTypes.sessionCompleted) return;
      const payload = envelope.payload as {
        sessionId: string;
        inputId?: string;
      };
      const claim = claims[dispatchKey(payload.sessionId, payload.inputId)];
      if (claim) {
        claim.status = "completed";
        persistClaims();
      }
    },
  });
  // The OS killed the prior service's cgroup. Never silently rerun a claim.
  for (const claim of Object.values(claims))
    if (claim.status === "active") {
      transport.send(daemonMessageTypes.sessionCompleted, {
        sessionId: claim.sessionId,
        inputId: claim.inputId,
        error:
          "The execution host stopped. Its process tree was stopped by the service manager; retry explicitly to start a new execution.",
      });
      claim.status = "completed";
    }
  persistClaims();
  await superviseAgentProcesses();
  reapConnectorLeftovers(console.error);
  clearClaudeSettingsFiles();
  startSessionTimers(serverURL);
  onIssueEnvironmentChange((change) =>
    transport.send(daemonMessageTypes.issueEnvironmentChanged, change),
  );
  setOutOfBandSessionEventSink(outOfBandEventSink(transport));
  setSessionTurnSink((sessionId, running) =>
    transport.send(daemonMessageTypes.sessionTurn, { sessionId, running }),
  );
  const scheduler = new ConcurrentTaskScheduler(
    readAgentRuntimeSettings().maxConcurrentTasks,
  );
  let owner: { pid: number; startTime: string } | undefined;
  let connection: Socket | undefined;
  const write = (socket: Socket, value: unknown) =>
    socket.write(`${JSON.stringify(value)}\n`);
  const snapshot = () => ({
    protocol: 1,
    serverURL,
    pid: process.pid,
    startTime: processIdentity(process.pid)?.startTime,
    claims: Object.values(claims).filter((claim) => claim.status === "active"),
    ownTurns: [...activeClaudeRuntimes.values()].flatMap((runtime) =>
      runtime.ownTurnSessionId ? [runtime.ownTurnSessionId] : [],
    ),
    background: [...activeClaudeRuntimes.values()]
      .filter((runtime) =>
        sessionHasRunningBackgroundTasks(runtime.foundrySessionId ?? ""),
      )
      .map((runtime) => runtime.foundrySessionId),
  });
  const announce = () => {
    if (connection) write(connection, { type: "snapshot", ...snapshot() });
  };
  const ticker = setInterval(announce, 5000);
  ticker.unref();
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
        try {
          if (line.length > 16 * 1024 * 1024)
            throw new Error("Execution control message too large");
          const request = JSON.parse(line);
          id = request.id;
          if (!authenticated) {
            const supplied = Buffer.from(String(request.token ?? ""));
            if (
              supplied.length !== Buffer.byteLength(token) ||
              !timingSafeEqual(supplied, Buffer.from(token))
            )
              throw new Error("Execution host authentication failed");
            const identity = processIdentity(request.owner?.pid);
            if (!identity || identity.startTime !== request.owner?.startTime)
              throw new Error("Worker identity no longer exists");
            if (
              owner &&
              (owner.pid !== request.owner.pid ||
                owner.startTime !== request.owner.startTime) &&
              processIdentity(owner.pid)?.startTime === owner.startTime
            )
              throw new Error("Another live worker owns the execution host");
            owner = request.owner;
            connection?.destroy();
            connection = socket;
            authenticated = true;
            clearTimeout(authDeadline);
            write(socket, { id, result: snapshot() });
            transport.bind(relay);
            return;
          }
          if (connection !== socket)
            throw new Error("This worker connection has been replaced");
          let result: unknown = {};
          if (request.method === "ack") {
            transport.acknowledge(request.envelopeId);
            return;
          }
          if (request.method === "run") {
            const payload = request.payload as RunSessionPayload;
            if (!payload?.session?.id || !request.workspacePath)
              throw new Error("Execution requires a session and workspace");
            const session = payload.session;
            const inputId = session.input?.id ?? "";
            const key = dispatchKey(session.id, inputId);
            if (!claims[key]) {
              claims[key] = {
                sessionId: session.id,
                inputId,
                status: "active",
              };
              persistClaims();
              if (inputId) noteSessionInput(session.id, inputId);
              scheduler.setMaxConcurrentTasks(
                readAgentRuntimeSettings().maxConcurrentTasks,
              );
              void scheduler
                .schedule(
                  session.issueId
                    ? `issue:${session.issueId}`
                    : [
                        "session",
                        session.workspaceId,
                        session.provider,
                        session.threadId?.trim() ||
                          session.nativeSessionId?.trim() ||
                          session.id,
                      ].join(":"),
                  async () => {
                    try {
                      if (session.role === "issue_execution")
                        await runDispatchedIssue(
                          serverURL,
                          request.workspacePath,
                          transport,
                          payload,
                        );
                      else
                        await runAgentSession(
                          serverURL,
                          request.workspacePath,
                          transport,
                          payload,
                        );
                    } catch (error) {
                      transport.send(daemonMessageTypes.sessionCompleted, {
                        sessionId: session.id,
                        inputId,
                        error:
                          error instanceof Error
                            ? error.message
                            : String(error),
                      });
                    } finally {
                      claims[key]!.status = "completed";
                      persistClaims();
                      announce();
                      if (session.issueId)
                        transport.send(daemonMessageTypes.readyForIssue, {});
                    }
                  },
                )
                .catch((error) => {
                  console.error(error);
                  process.exitCode = 1;
                  closeAllActiveRuntimes();
                  server.close();
                });
              announce();
            }
            result = { status: claims[key]!.status };
          } else if (request.method === "steer") {
            if (!request.inputId)
              throw new Error("Steer requires a stable input identity");
            const key = dispatchKey(request.sessionId, request.inputId);
            if (controls[key] === "accepted") {
              /* Already accepted by this execution owner. */
            } else if (controlFlights.has(key)) await controlFlights.get(key);
            else if (controls[key])
              throw new ControlOutcomeUnknownError(
                "The previous steer outcome is unknown; it will not be applied again.",
              );
            else {
              controls[key] = "pending";
              persistControls();
              const applying = steerActiveSessionOnce(
                request.sessionId,
                request.inputId,
                request.message,
                request.attachments,
              );
              controlFlights.set(key, applying);
              try {
                await applying;
                controls[key] = "accepted";
              } catch (error) {
                if (error instanceof ControlOutcomeUnknownError)
                  controls[key] = "unknown";
                else delete controls[key];
                throw error;
              } finally {
                persistControls();
                controlFlights.delete(key);
              }
            }
          } else if (request.method === "cancel") {
            result = await cancelActiveSession(
              request.sessionId,
              request.inputId,
            );
          } else if (request.method === "stop_background") {
            await stopClaudeBackgroundTask(request.sessionId, request.taskId);
          } else if (request.method === "issue_environment") {
            const payload = request.payload;
            if (payload.action === "preview_start") {
              queuePreview(payload.issueId);
              void scheduler
                .schedule(`issue:${payload.issueId}`, () =>
                  runIssuePreview(payload.workspaceId, payload.issueId),
                )
                .catch(console.error);
              result = { status: "preview_queued", revision: payload.revision };
            } else result = await issueEnvironmentAction(payload);
          } else if (request.method === "evidence") {
            result = await evidenceWorkerAction(request.payload);
          } else if (request.method === "timers") {
            sessionTimers.adopt([request.timers]);
          } else if (request.method === "snapshot") result = snapshot();
          else throw new Error("Unsupported execution host command");
          write(socket, { id, result });
        } catch (error) {
          write(socket, {
            id,
            error: error instanceof Error ? error.message : String(error),
            outcomeUnknown: error instanceof ControlOutcomeUnknownError,
          });
          if (!authenticated) socket.end();
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
