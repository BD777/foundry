import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CandidateSnapshot, TargetSnapshot } from "@foundry/protocol";
import { childPath } from "./execution-storage.js";
import { digestObject } from "./evidence-store.js";

export interface LocalHTTPServiceDefinition {
  name: string;
  // v1 adapter: candidate ESM default export is a Node HTTP request listener.
  entrypointRelativePath: string;
}
interface ManagedService {
  child: ChildProcess;
  url: string;
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
  if (process.platform !== "darwin")
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
      'await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));',
      // Send the kernel-assigned listener before any candidate code can emit IPC.
      "send({port:server.address().port});",
      "handler=(await import(pathToFileURL(process.argv[2]).href)).default;",
      'if (typeof handler !== "function") throw new Error("Target must export a Node HTTP request handler");',
      "send({ready:true});",
      'process.on("disconnect",()=>process.exit(0));',
    ].join("\n"),
    { mode: 0o400, flag: "wx" },
  );
  const profile = resolve(runtimeDirectory, "service.sb");
  writeFileSync(
    profile,
    [
      "(version 1)",
      "(deny default)",
      "(allow process-exec)",
      "(allow process-fork)",
      "(allow signal (target self))",
      "(allow sysctl-read)",
      "(allow mach-lookup)",
      "(allow file-read-metadata)",
      ...[
        "/usr",
        "/bin",
        "/System",
        "/Library",
        "/opt/homebrew",
        "/private/etc",
        "/private/var/db",
        candidateDirectory,
        runtimeDirectory,
      ].map(
        (path) => `(allow file-read-data (subpath ${JSON.stringify(path)}))`,
      ),
      '(allow file-read-data (literal "/") (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))',
      '(allow file-write* (literal "/dev/null"))',
      '(allow network-bind (local tcp "localhost:*"))',
      '(allow network-inbound (local tcp "localhost:*"))',
    ].join("\n"),
    { mode: 0o400, flag: "wx" },
  );
  const child = spawn(
    "/usr/bin/sandbox-exec",
    ["-f", profile, process.execPath, wrapper, entrypoint],
    {
      cwd: candidateDirectory,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: runtimeDirectory,
        TMPDIR: runtimeDirectory,
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      detached: true,
    },
  );
  let errorText = "";
  child.stderr?.on("data", (chunk) => {
    if (errorText.length < 4096) errorText += chunk.toString();
  });
  const port = await new Promise<number>((done, reject) => {
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
    let assignedPort: number | undefined;
    child.on("message", (message: unknown) => {
      if (assignedPort === undefined) {
        const port = (message as { port?: number })?.port;
        if (!Number.isInteger(port) || port! < 1024 || port! > 65535) {
          clearTimeout(timer);
          child.kill("SIGKILL");
          reject(new Error("invalid_service_port"));
          return;
        }
        assignedPort = port;
      } else if ((message as { ready?: boolean })?.ready) {
        clearTimeout(timer);
        done(assignedPort);
      }
    });
  });
  const instanceId = `service_${randomUUID()}`;
  const service = {
    child,
    url: `http://127.0.0.1:${port}`,
    candidateSnapshotId: candidate.id,
    workspaceId: candidate.workspaceId,
    issueId: candidate.issueId,
  };
  services.set(instanceId, service);
  child.once("exit", () => services.delete(instanceId));
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
  }
}

export function stopAllEvidenceHTTPServices(): void {
  for (const issueId of new Set(
    [...services.values()].map((service) => service.issueId),
  ))
    stopEvidenceHTTPServices(issueId);
}
