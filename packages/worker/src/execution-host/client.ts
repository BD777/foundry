/** Authenticated local control link; reconnect never starts an agent again. */
import { connect, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  realpathSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ChatAttachment,
  RunSessionPayload,
  SessionTimers,
  EvidenceWorkerRequest,
} from "@bd777/foundry-protocol";
import { ControlOutcomeUnknownError } from "../session-control.js";
import { processIdentity } from "../agent-processes.js";
import type { ReliableSessionTransport } from "../transport.js";
import type { SessionExecutionRegistry } from "../session-state.js";
import { executionHostPaths } from "./paths.js";

export interface HostSnapshot {
  protocol: number;
  serverURL?: string;
  pid: number;
  startTime: string;
  claims: Array<{ sessionId: string; inputId: string }>;
  background: string[];
  ownTurns?: string[];
}
let current: ExecutionHostClient | undefined;
export function executionHostClient(): ExecutionHostClient | undefined {
  return current;
}

export class ExecutionHostClient {
  private socket?: Socket;
  private pending = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private snapshot?: HostSnapshot;
  private transport?: ReliableSessionTransport;
  private earlyEnvelopes: Array<{
    id: string;
    type: string;
    payload: unknown;
  }> = [];
  private registry?: SessionExecutionRegistry;
  private claimed = new Map<string, { sessionId: string; inputId: string }>();
  private connecting?: Promise<void>;
  private token: string;
  constructor(
    private readonly socketPath: string,
    token: string,
    private readonly serverURL?: string,
  ) {
    this.token = token;
  }

  attach(
    transport: ReliableSessionTransport,
    registry: SessionExecutionRegistry,
  ): void {
    this.transport = transport;
    this.registry = registry;
    if (this.snapshot) this.adopt(this.snapshot);
    for (const envelope of this.earlyEnvelopes)
      transport.send(envelope.type, envelope.payload, envelope.id);
    this.earlyEnvelopes = [];
  }
  hasSession(sessionId: string): boolean {
    return (
      this.snapshot?.claims.some((claim) => claim.sessionId === sessionId) ===
        true || this.snapshot?.background.includes(sessionId) === true
    );
  }
  owns(sessionId: string, inputId: string): boolean {
    return (
      this.snapshot?.claims.some(
        (claim) => claim.sessionId === sessionId && claim.inputId === inputId,
      ) === true
    );
  }
  async open(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (this.socket && !this.socket.destroyed) return;
    this.connecting = this.connect().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }
  private async connect(): Promise<void> {
    const socket = connect(this.socketPath);
    await new Promise<void>((done, reject) => {
      socket.once("connect", done);
      socket.once("error", reject);
    });
    this.socket = socket;
    const lines = createInterface({ input: socket });
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      lines.close();
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(
          new ControlOutcomeUnknownError(
            "Execution host acknowledgement lost; outcome unknown. Reconnect before retrying.",
          ),
        );
      }
      this.pending.clear();
      // Keep claims while disconnected. Never call a still-running host's
      // executions orphaned just because its control socket dropped.
    });
    lines.on("line", (line) => {
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        socket.destroy();
        return;
      }
      if (message.type === "snapshot") {
        this.adopt(message);
        return;
      }
      if (message.type === "envelope") {
        const envelope = message.envelope;
        // Without an attached outbox the host retains and replays the event.
        if (this.transport)
          this.transport.send(envelope.type, envelope.payload, envelope.id);
        else this.earlyEnvelopes.push(envelope);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(
          message.outcomeUnknown
            ? new ControlOutcomeUnknownError(message.error)
            : new Error(message.error),
        );
      else pending.resolve(message.result);
    });
    const identity = processIdentity(process.pid);
    if (!identity) {
      socket.destroy();
      throw new Error("Cannot verify worker identity");
    }
    try {
      const snapshot = await this.send({
        token: this.token,
        owner: { pid: process.pid, startTime: identity.startTime },
      });
      if (
        (this.serverURL && snapshot.serverURL !== this.serverURL) ||
        snapshot.protocol !== 1 ||
        processIdentity(snapshot.pid)?.startTime !== snapshot.startTime
      )
        throw new Error("Execution host identity or protocol does not match");
      this.adopt(snapshot);
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }
  private adopt(snapshot: HostSnapshot): void {
    this.snapshot = snapshot;
    if (!this.registry) return;
    const next = new Map(
      snapshot.claims.map((claim) => [
        `${claim.sessionId}/${claim.inputId}`,
        claim,
      ]),
    );
    for (const [key, claim] of this.claimed)
      if (!next.has(key))
        this.registry.complete(claim.sessionId, claim.inputId);
    for (const [key, claim] of next)
      if (!this.claimed.has(key))
        this.registry.claim(claim.sessionId, claim.inputId);
    this.claimed = next;
  }
  private send(request: Record<string, unknown>): Promise<any> {
    const socket = this.socket;
    if (!socket || socket.destroyed)
      return Promise.reject(new Error("Execution host is disconnected"));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(
            new ControlOutcomeUnknownError(
              "Execution host acknowledgement timed out; outcome unknown.",
            ),
          );
        },
        request.method === "evidence" ? 15 * 60_000 : 35_000,
      );
      this.pending.set(id, { resolve, reject, timer });
      socket.write(`${JSON.stringify({ ...request, id })}\n`);
    });
  }
  async refresh(): Promise<void> {
    await this.open();
    this.adopt(await this.send({ method: "snapshot" }));
  }
  async run(workspacePath: string, payload: RunSessionPayload): Promise<void> {
    await this.open();
    await this.send({ method: "run", workspacePath, payload });
    await this.refresh();
  }
  async steer(
    sessionId: string,
    inputId: string | undefined,
    message: string,
    attachments: ChatAttachment[],
  ): Promise<void> {
    await this.open();
    await this.send({
      method: "steer",
      sessionId,
      inputId,
      message,
      attachments,
    });
  }
  async cancel(
    sessionId: string,
    inputId?: string,
  ): Promise<{ answered?: boolean }> {
    await this.open();
    return this.send({ method: "cancel", sessionId, inputId });
  }
  async stopBackground(sessionId: string, taskId: string): Promise<void> {
    await this.open();
    await this.send({ method: "stop_background", sessionId, taskId });
  }
  async issueEnvironment(
    payload: Parameters<
      typeof import("../issue-environment-rpc.js").issueEnvironmentAction
    >[0],
  ): Promise<unknown> {
    await this.open();
    return this.send({ method: "issue_environment", payload });
  }
  async evidence(payload: EvidenceWorkerRequest): Promise<unknown> {
    await this.open();
    return this.send({ method: "evidence", payload });
  }
  async adoptTimers(timers: SessionTimers): Promise<void> {
    await this.open();
    await this.send({ method: "timers", timers });
  }
  reportOwnTurns(): void {
    for (const sessionId of this.snapshot?.ownTurns ?? [])
      this.transport?.send("session_turn", { sessionId, running: true });
  }
  acknowledge(envelopeId: string): void {
    if (this.socket && !this.socket.destroyed)
      this.socket.write(`${JSON.stringify({ method: "ack", envelopeId })}\n`);
  }
  close(): void {
    this.socket?.destroy();
  }
}

/** Linux service isolation is required, not an optimistic detached child. */
export async function startExecutionHost(
  serverURL: string,
): Promise<ExecutionHostClient | undefined> {
  if (
    process.platform !== "linux" ||
    !process.env.XDG_RUNTIME_DIR ||
    process.env.NODE_TEST_CONTEXT
  )
    return undefined;
  const paths = executionHostPaths();
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(paths.token, randomBytes(32).toString("hex"), {
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const client = new ExecutionHostClient(
    paths.socket,
    readFileSync(paths.token, "utf8").trim(),
    serverURL,
  );
  try {
    await client.open();
    current = client;
    return client;
  } catch {
    /* Ask the service manager; a duplicate unit cannot start twice. */
  }
  const entry = realpathSync(
    fileURLToPath(new URL("./main.js", import.meta.url)),
  );
  const environment = [
    "PATH",
    "HOME",
    "FOUNDRY_STATE_ROOT",
    "FOUNDRY_STACK",
    "FOUNDRY_TOOLS_ROOT",
    "FOUNDRY_CODEX_BIN",
    "FOUNDRY_CLAUDE_BIN",
  ].flatMap((name) =>
    process.env[name] ? [`--setenv=${name}=${process.env[name]}`] : [],
  );
  let launchError: Error | undefined;
  await new Promise<void>((done) =>
    execFile(
      "systemd-run",
      [
        "--user",
        "--quiet",
        "--collect",
        `--unit=${paths.unit}`,
        "--service-type=exec",
        "--property=KillMode=control-group",
        "--property=Restart=on-failure",
        "--property=RestartSec=1s",
        "--property=TimeoutStopSec=10s",
        ...environment,
        process.execPath,
        entry,
        serverURL,
      ],
      { timeout: 15_000 },
      (error) => {
        launchError = error ?? undefined;
        done();
      },
    ),
  );
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await client.open();
      current = client;
      return client;
    } catch {
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  throw new Error(
    `Execution host could not be reached; refusing to launch unmanaged work. ${launchError?.message ?? "See its user service log."}`,
  );
}

export async function stopExecutionHost(): Promise<void> {
  const paths = executionHostPaths();
  const identity = resolve(paths.root, "identity.json");
  if (!current && !existsSync(identity)) return;
  await new Promise<void>((done, reject) =>
    execFile(
      "systemctl",
      ["--user", "stop", paths.unit],
      { timeout: 20_000 },
      (error, _stdout, stderr) =>
        error && !/not loaded|not found/.test(stderr) ? reject(error) : done(),
    ),
  );
  current?.close();
  current = undefined;
  try {
    unlinkSync(identity);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
