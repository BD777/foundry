// Container runtimes: Docker and Podman, asked about their local engine
// only. A client pointed at a remote engine (DOCKER_HOST, a remote context,
// CONTAINER_HOST) is listed without asking it, as detection makes no
// network calls.

import type { ResourceReadiness } from "@bd777/foundry-protocol";
import {
  resourcePlatform,
  type DetectContext,
  type DetectedInstance,
  type Detector,
} from "../detector.js";
import { findOnPath, firstLine } from "../exec.js";

function isLocalEndpoint(host: string): boolean {
  return host === "" || /^(unix|npipe):\/\//.test(host);
}

async function dockerEndpoint(
  context: DetectContext,
  docker: string,
): Promise<string> {
  if (context.env.DOCKER_HOST !== undefined) return context.env.DOCKER_HOST;
  const run = await context.exec(
    docker,
    ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
    { timeoutMs: 2000 },
  );
  return run.code === 0 ? run.stdout.trim() : "";
}

async function engine(
  context: DetectContext,
  id: "docker" | "podman",
  name: string,
  program: string,
  endpoint: string,
  infoArgs: string[],
): Promise<DetectedInstance> {
  const instance = (
    readiness: ResourceReadiness,
    details: Record<string, string>,
  ): DetectedInstance => ({
    key: `container_runtime/${id}`,
    type: "container_runtime",
    platform: resourcePlatform(context.platform),
    name,
    readiness,
    backends: [{ id, mode: "listed", readiness }],
    details: { path: program, ...details },
  });
  if (!isLocalEndpoint(endpoint))
    return instance(
      {
        ready: false,
        level: "configured",
        reason: "It points at a remote engine, which detection does not ask.",
      },
      { endpoint: endpoint.replace(/\/\/[^@/]*@/, "//") },
    );
  const run = await context.exec(program, infoArgs, { timeoutMs: 5000 });
  if (run.code !== 0)
    return instance(
      {
        ready: false,
        level: "installed",
        reason:
          firstLine(run.stderr) ||
          `Its engine did not answer (exit ${run.code}).`,
      },
      {},
    );
  const [version, os, cpus] = run.stdout.trim().split("\t");
  return instance(
    { ready: true, level: "configured" },
    Object.fromEntries(
      Object.entries({ engineVersion: version, os, cpus }).filter(
        (entry): entry is [string, string] => Boolean(entry[1]),
      ),
    ),
  );
}

export const containerRuntimeDetector: Detector = {
  id: "container_runtime",
  version: 1,
  type: "container_runtime",
  platforms: ["darwin", "linux", "win32"],
  intervalMs: 5 * 60_000,
  timeoutMs: 9000,
  async detect(context) {
    const found: Promise<DetectedInstance>[] = [];
    const docker = findOnPath("docker", context.env, context.platform);
    if (docker)
      found.push(
        dockerEndpoint(context, docker).then((endpoint) =>
          engine(context, "docker", "Docker", docker, endpoint, [
            "info",
            "--format",
            "{{.ServerVersion}}\t{{.OperatingSystem}}\t{{.NCPU}}",
          ]),
        ),
      );
    const podman = findOnPath("podman", context.env, context.platform);
    if (podman)
      found.push(
        engine(
          context,
          "podman",
          "Podman",
          podman,
          context.env.CONTAINER_HOST ?? "",
          ["info", "--format", "{{.Version.Version}}"],
        ),
      );
    return Promise.all(found);
  },
};
