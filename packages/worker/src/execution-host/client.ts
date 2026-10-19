/** Authenticated local control link; reconnect never starts an agent again. */
import { connect, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { randomBytes, randomUUID } from "node:crypto";
import {
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
import {
  executionServiceSupported,
  prepareExecutionSocket,
  launchExecutionService,
  stopExecutionService,
  runtimeStamp,
  legacyExecutionHostIsAlone,
} from "./service.js";

export interface HostSnapshot {
  protocol: number;
  capabilities?: string[];
  entry?: string;
  runtimeStamp?: string;
  busy?: boolean;
  draining?: boolean;
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
  private switching?: Promise<void>;
  private closed = false;
  private token: string;
  constructor(
    private readonly socketPath: string,
    token: string,
    private readonly serverURL?: string,
    private readonly managed?: {
      entry: string;
      stamp: string;
      start: () => Promise<void>;
      stop: () => Promise<void>;
      legacyAlone: (pid: number) => boolean;
    },
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
  supportsCapability(capability: string): boolean {
    return (
      !!this.socket &&
      !this.socket.destroyed &&
      this.snapshot?.capabilities?.includes(capability) === true
    );
  }
  async open(): Promise<void> {
    if (this.closed) throw new Error("Execution host client is closed.");
    if (this.switching) return this.switching;
    if (this.connecting) return this.connecting;
    if (this.socket && !this.socket.destroyed) return;
    this.connecting = this.connect()
      .catch(async (error) => {
        if (
          this.closed ||
          !this.managed ||
          !this.serverURL ||
          /Another live worker|authentication failed|identity or protocol/.test(
            String(error),
          )
        )
          throw error;
        // The registered service may have stopped or be recovering. Recreate
        // it only through its manager, never as an unmanaged child.
        await this.managed.start().catch(() => undefined);
        await this.awaitService();
      })
      .finally(() => {
        this.connecting = undefined;
      });
    return this.connecting;
  }
  private async connect(): Promise<void> {
    if (this.closed) throw new Error("Execution host client is closed.");
    const socket = connect(this.socketPath);
    await new Promise<void>((done, reject) => {
      socket.once("connect", done);
      socket.once("error", reject);
    });
    if (this.closed) {
      socket.destroy();
      throw new Error("Execution host client is closed.");
    }
    this.socket = socket;
    const lines = createInterface({ input: socket });
    // readline forwards its input's errors as its own error event. A broken
    // pipe during service replacement must close the link, not the worker.
    lines.on("error", () => socket.destroy());
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
  private async awaitService(): Promise<void> {
    let last: unknown;
    for (let i = 0; i < 100; i++) {
      if (this.closed) throw new Error("Execution host client is closed.");
      try {
        await this.connect();
        return;
      } catch (error) {
        last = error;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw last ?? new Error("Execution service did not become ready.");
  }
  private async command(request: Record<string, unknown>): Promise<any> {
    await this.open();
    if (this.switching) await this.switching;
    return this.send(request);
  }
  private async upgradeIfIdle(snapshot: HostSnapshot): Promise<void> {
    if (!this.managed || !this.serverURL || this.switching || this.pending.size)
      return;
    let entry = snapshot.entry;
    if (!entry) {
      try {
        const identity = JSON.parse(
          readFileSync(
            resolve(executionHostPaths().root, "identity.json"),
            "utf8",
          ),
        );
        if (
          identity.pid === snapshot.pid &&
          identity.startTime === snapshot.startTime
        )
          entry = identity.entry;
      } catch {}
    }
    const changed =
      entry &&
      (entry !== this.managed.entry ||
        (snapshot.runtimeStamp &&
          snapshot.runtimeStamp !== this.managed.stamp));
    if (!changed) {
      if (snapshot.draining) await this.send({ method: "cancel_upgrade" });
      return;
    }
    if (
      snapshot.busy ||
      snapshot.claims.length ||
      snapshot.background.length ||
      snapshot.ownTurns?.length
    )
      return;
    const canDrain = snapshot.capabilities?.includes("idle_upgrade");
    if (!canDrain && !this.managed.legacyAlone(snapshot.pid)) return;
    this.switching = (async () => {
      if (canDrain && !(await this.send({ method: "prepare_upgrade" })).ready)
        return;
      if (this.closed) return;
      // No RPC can cross this point: command() waits for the replacement,
      // while the old owner has atomically refused new work.
      this.socket?.destroy();
      this.socket = undefined;
      await this.managed!.stop();
      if (this.closed) return;
      await this.managed!.start();
      await this.awaitService();
    })()
      .catch(async (error) => {
        // If stopping failed, release the old service's drain rather than
        // leaving it frozen. If it is gone, the next open asks its manager.
        try {
          await this.connect();
          await this.send({ method: "cancel_upgrade" });
        } catch {}
        throw error;
      })
      .finally(() => {
        this.switching = undefined;
      });
    await this.switching;
  }
  async refresh(): Promise<void> {
    const snapshot = await this.command({ method: "snapshot" });
    this.adopt(snapshot);
    await this.upgradeIfIdle(snapshot);
  }
  async run(workspacePath: string, payload: RunSessionPayload): Promise<void> {
    await this.command({ method: "run", workspacePath, payload });
    await this.refresh();
  }
  async steer(
    sessionId: string,
    inputId: string | undefined,
    message: string,
    attachments: ChatAttachment[],
    sentBySessionId?: string,
  ): Promise<void> {
    await this.command({
      method: "steer",
      sessionId,
      inputId,
      message,
      attachments,
      sentBySessionId,
    });
  }
  async cancel(
    sessionId: string,
    inputId?: string,
  ): Promise<{ answered?: boolean }> {
    return this.command({ method: "cancel", sessionId, inputId });
  }
  async stopBackground(sessionId: string, taskId: string): Promise<void> {
    await this.command({ method: "stop_background", sessionId, taskId });
  }
  async issueEnvironment(
    payload: Parameters<
      typeof import("../issue-environment-rpc.js").issueEnvironmentAction
    >[0],
  ): Promise<unknown> {
    return this.command({ method: "issue_environment", payload });
  }
  async evidence(payload: EvidenceWorkerRequest): Promise<unknown> {
    return this.command({ method: "evidence", payload });
  }
  async adoptTimers(timers: SessionTimers): Promise<void> {
    await this.command({ method: "timers", timers });
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
    this.closed = true;
    this.socket?.destroy();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new ControlOutcomeUnknownError(
          "Execution host client closed; pending outcome unknown.",
        ),
      );
    }
    this.pending.clear();
  }
  async shutdown(): Promise<void> {
    this.close();
    await Promise.allSettled([this.connecting, this.switching].filter(Boolean));
  }
}

/** The OS manager owns executions; a Worker only owns the control link. */
export async function startExecutionHost(
  serverURL: string,
): Promise<ExecutionHostClient | undefined> {
  if (!executionServiceSupported() || process.env.NODE_TEST_CONTEXT)
    return undefined;
  const paths = executionHostPaths();
  prepareExecutionSocket();
  try {
    writeFileSync(paths.token, randomBytes(32).toString("hex"), {
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const entry = realpathSync(
    fileURLToPath(new URL("./main.js", import.meta.url)),
  );
  const client = new ExecutionHostClient(
    paths.socket,
    readFileSync(paths.token, "utf8").trim(),
    serverURL,
    {
      entry,
      stamp: runtimeStamp(entry),
      start: () => launchExecutionService(entry, serverURL),
      stop: stopExecutionService,
      legacyAlone: legacyExecutionHostIsAlone,
    },
  );
  await client.open();
  await client.refresh();
  current = client;
  return client;
}

export async function stopExecutionHost(): Promise<void> {
  const paths = executionHostPaths();
  const identity = resolve(paths.root, "identity.json");
  if (!current && !existsSync(identity) && !existsSync(paths.plist)) return;
  await current?.shutdown();
  await stopExecutionService();
  current = undefined;
  try {
    unlinkSync(identity);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
