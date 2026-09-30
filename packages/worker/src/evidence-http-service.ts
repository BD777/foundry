import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  CandidateSnapshot,
  TargetSnapshot,
} from "@bd777/foundry-protocol";
import { childPath } from "./execution-storage.js";
import { digestObject } from "./evidence-store.js";
import {
  sandboxAvailable,
  sandboxLaunch,
  type ServiceEndpoint,
} from "./sandbox/index.js";

export interface LocalHTTPServiceDefinition {
  name: string;
  // v1 adapter: candidate ESM default export is a Node HTTP request listener.
  entrypointRelativePath: string;
}
interface ManagedService {
  child: ChildProcess;
  url: string;
  /** Host side of a service reached over a Unix socket. */
  bridge?: Server;
  socketDirectory: string;
  candidateSnapshotId: string;
  workspaceId: string;
  issueId: string;
}
const services = new Map<string, ManagedService>();

/**
 * A live instance is bound to one immutable materialization. It has no host
 * credentials, outbound networking, shell tools or canonical-source access.
 * A Worker restart loses the lease; it never silently restarts a tested service.
 */
export async function startEvidenceHTTPService(
  definition: LocalHTTPServiceDefinition,
  candidate: CandidateSnapshot,
  candidateDirectory: string,
  runtimeDirectory: string,
): Promise<TargetSnapshot> {
  if (!sandboxAvailable("loopback_service"))
    throw new Error("http_service_isolation_unavailable");
  if (!definition.name.trim()) throw new Error("target_name_required");
  const entrypoint = childPath(
    candidateDirectory,
    definition.entrypointRelativePath,
  );
  if (!candidate.repositories.some((repo) => repo.kind === "root"))
    throw new Error("root_repository_required");
  mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
  const wrapper = resolve(runtimeDirectory, "server.mjs");
  writeFileSync(
    wrapper,
    [
      'import http from "node:http";',
      'import { pathToFileURL } from "node:url";',
      "let handler; const send=process.send.bind(process);",
      "const server=http.createServer((req,res)=>handler ? handler(req,res) : (res.writeHead(503),res.end()));",
      // A Unix socket where the sandbox shares no network with the host,
      // else a free loopback port.
      "const socket=process.env.FOUNDRY_SERVICE_SOCKET; delete process.env.FOUNDRY_SERVICE_SOCKET;",
      'await new Promise(resolve=>socket ? server.listen(socket,resolve) : server.listen(0,"127.0.0.1",resolve));',
      // Report the listener before any candidate code can emit IPC.
      "send(socket ? {socket:true} : {port:server.address().port});",
      "handler=(await import(pathToFileURL(process.argv[2]).href)).default;",
      'if (typeof handler !== "function") throw new Error("Target must export a Node HTTP request handler");',
      "send({ready:true});",
      'process.on("disconnect",()=>process.exit(0));',
    ].join("\n"),
    { mode: 0o400, flag: "wx" },
  );
  const socketDirectory = mkdtempSync(join(shortTemporaryRoot(), "fdy-"));
  const launch = sandboxLaunch(
    {
      kind: "loopback_service",
      policyFile: resolve(runtimeDirectory, "service.sb"),
      readRoots: [candidateDirectory, runtimeDirectory],
      socketDirectory,
    },
    process.execPath,
    [wrapper, entrypoint],
  );
  const endpoint: ServiceEndpoint = launch.endpoint ?? {
    kind: "loopback_tcp",
  };
  const child = spawn(launch.command, launch.args, {
    cwd: candidateDirectory,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: runtimeDirectory,
      TMPDIR: runtimeDirectory,
      ...(endpoint.kind === "unix"
        ? { FOUNDRY_SERVICE_SOCKET: endpoint.servicePath }
        : {}),
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    detached: true,
  });
  let errorText = "";
  child.stderr?.on("data", (chunk) => {
    if (errorText.length < 4096) errorText += chunk.toString();
  });
  const listening = new Promise<number | undefined>((done, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("http_service_start_timeout"));
    }, 10000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`http_service_start_failed: ${errorText}`));
    });
    let listener: { port?: number } | undefined;
    child.on("message", (message: unknown) => {
      if (listener === undefined) {
        const reported = message as { port?: number; socket?: boolean };
        const valid =
          endpoint.kind === "unix"
            ? reported?.socket === true
            : Number.isInteger(reported?.port) &&
              reported.port! >= 1024 &&
              reported.port! <= 65535;
        if (!valid) {
          clearTimeout(timer);
          child.kill("SIGKILL");
          reject(new Error("invalid_service_port"));
          return;
        }
        listener = { port: reported.port };
      } else if ((message as { ready?: boolean })?.ready) {
        clearTimeout(timer);
        done(listener.port);
      }
    });
  });
  let port: number;
  let bridge: Server | undefined;
  try {
    const reported = await listening;
    if (endpoint.kind === "unix") {
      bridge = await bridgeToSocket(endpoint.hostPath);
      port = (bridge.address() as { port: number }).port;
    } else port = reported!;
  } catch (error) {
    rmSync(socketDirectory, { recursive: true, force: true });
    throw error;
  }
  const instanceId = `service_${randomUUID()}`;
  const service: ManagedService = {
    child,
    url: `http://127.0.0.1:${port}`,
    bridge,
    socketDirectory,
    candidateSnapshotId: candidate.id,
    workspaceId: candidate.workspaceId,
    issueId: candidate.issueId,
  };
  services.set(instanceId, service);
  child.once("exit", () => {
    services.delete(instanceId);
    release(service);
  });
  return {
    name: definition.name,
    kind: "service",
    locatorLabel: `Managed local HTTP: ${definition.name}`,
    instanceId,
    build: {
      digest: digestObject({
        candidateDigest: candidate.contentDigest,
        definition,
        node: process.version,
      }),
      sourceCandidateSnapshotId: candidate.id,
      producerDeviceId: "",
    },
    observedIdentity: instanceId,
    identityMethod: "local_snapshot",
    bindingStatus: "verified",
    observedAt: new Date().toISOString(),
  };
}

export function evidenceHTTPServiceURL(
  target: TargetSnapshot,
  candidate: CandidateSnapshot,
): string {
  const service = target.instanceId
    ? services.get(target.instanceId)
    : undefined;
  if (
    !service ||
    service.child.exitCode !== null ||
    service.child.killed ||
    service.candidateSnapshotId !== candidate.id ||
    service.issueId !== candidate.issueId ||
    service.workspaceId !== candidate.workspaceId
  )
    throw new Error(
      "target_instance_unavailable: seal a new input and reverify; service is never silently restarted",
    );
  return service.url;
}

export function stopEvidenceHTTPServices(issueId: string): void {
  for (const [id, service] of services) {
    if (service.issueId !== issueId) continue;
    try {
      if (service.child.pid) process.kill(-service.child.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    services.delete(id);
    release(service);
  }
}

export function stopAllEvidenceHTTPServices(): void {
  for (const issueId of new Set(
    [...services.values()].map((service) => service.issueId),
  ))
    stopEvidenceHTTPServices(issueId);
}

/** Unix socket paths must stay under ~100 bytes; TMPDIR can be deep. */
function shortTemporaryRoot(): string {
  const root = tmpdir();
  return root.length <= 64 ? root : "/tmp";
}

/**
 * A host loopback port whose connections are relayed to the service's Unix
 * socket, so callers reach every managed service by a 127.0.0.1 URL.
 */
async function bridgeToSocket(socketPath: string): Promise<Server> {
  const bridge = createServer((client) => {
    const upstream = createConnection(socketPath);
    client.pipe(upstream).pipe(client);
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close);
    upstream.on("error", close);
  });
  await new Promise<void>((done, reject) => {
    bridge.once("error", reject);
    bridge.listen(0, "127.0.0.1", done);
  });
  return bridge;
}

function release(service: ManagedService): void {
  service.bridge?.close();
  rmSync(service.socketDirectory, { recursive: true, force: true });
}
