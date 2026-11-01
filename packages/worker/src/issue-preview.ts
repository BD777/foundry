import { readFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { ExecutionStore } from "./execution-storage.js";
import { sandboxCommand, executorEnvironment } from "./execution-sandbox.js";
import { spawnProcessGroup } from "./process-group.js";
import { sleep } from "./utils.js";
import { issueEnvironmentChanged } from "./issue-environment-changes.js";

type Preview = {
  state: "queued" | "running" | "stopped" | "failed";
  url?: string;
  error?: string;
  control: AbortController;
  done?: Promise<void>;
};
function isPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolveCheck) => {
    const server = createServer();
    server.once("error", () => resolveCheck(false));
    server.once("listening", () => {
      server.close(() => resolveCheck(true));
    });
    server.listen(port, host);
  });
}

async function waitForPreview(
  url: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status < 500) {
        return true;
      }
    } catch {
      // Preview may still be booting.
    }
    await sleep(250);
  }
  return false;
}

const previews = new Map<string, Preview>();
const leasedPorts = new Set<number>();
async function reservePort(start = 4300, end = start + 99): Promise<number> {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 1024 ||
    end > 65535 ||
    end < start
  )
    throw new Error("Invalid preview port range");
  for (let port = start; port <= end; port++) {
    if (leasedPorts.has(port)) continue;
    if ((await isPortAvailable("127.0.0.1", port)) && !leasedPorts.has(port)) {
      leasedPorts.add(port);
      return port;
    }
  }
  throw new Error("No preview port is available");
}
export function previewStatus(
  issueId: string,
): { state: string; url?: string; error?: string } | undefined {
  const p = previews.get(issueId);
  return p ? { state: p.state, url: p.url, error: p.error } : undefined;
}
export function queuePreview(issueId: string): void {
  const previous = previews.get(issueId);
  if (previous && ["queued", "running"].includes(previous.state))
    throw new Error("Preview already exists");
  previews.set(issueId, { state: "queued", control: new AbortController() });
  issueEnvironmentChanged({ issueId });
}
export async function stopIssuePreview(issueId: string): Promise<void> {
  const preview = previews.get(issueId);
  if (preview) {
    preview.control.abort();
    await preview.done?.catch(() => {});
    preview.state = "stopped";
    issueEnvironmentChanged({ issueId });
  }
}
export async function runIssuePreview(
  workspaceId: string,
  issueId: string,
  store = new ExecutionStore(),
): Promise<void> {
  const preview = previews.get(issueId);
  if (!preview || preview.control.signal.aborted) return;
  let port: number | undefined;
  try {
    const environment = store.environment(workspaceId, issueId);
    const registration = store.registration(workspaceId);
    if (!environment || environment.status !== "review" || !registration)
      throw new Error("Preview requires a review candidate");
    const configPath = resolve(environment.sourcePath, ".foundry/preview.json");
    if (!existsSync(configPath))
      throw new Error("Workspace has no .foundry/preview.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    if (typeof config.command !== "string" || !config.command.trim())
      throw new Error("Preview command is missing");
    port = await reservePort(config.portStart, config.portEnd);
    const spec = sandboxCommand(environment, registration, "/bin/sh", [
      "-lc",
      config.command,
    ]);
    const child = spawnProcessGroup(
      spec.command,
      spec.args,
      {
        cwd: environment.cwd,
        env: {
          ...executorEnvironment(environment),
          FOUNDRY_PREVIEW_PORT: String(port),
          PORT: String(port),
        },
      },
      preview.control.signal,
      900_000,
    );
    child.stdin.end();
    const log = await import("node:fs");
    child.stdout.on("data", (data) =>
      log.appendFileSync(
        resolve(environment.scratch, "preview.stdout.log"),
        data,
      ),
    );
    child.stderr.on("data", (data) =>
      log.appendFileSync(
        resolve(environment.scratch, "preview.stderr.log"),
        data,
      ),
    );
    preview.done = new Promise<void>((done, reject) => {
      child.once("close", (code) => {
        preview.state =
          code === 0 || preview.control.signal.aborted ? "stopped" : "failed";
        done();
      });
      child.once("error", reject);
    });
    const url = `http://127.0.0.1:${port}${config.readyPath ?? "/"}`;
    if (
      !(await waitForPreview(
        url,
        Math.min(config.readyTimeoutMs ?? 15000, 30000),
      ))
    )
      throw new Error(
        "Preview did not become ready; see candidate scratch logs",
      );
    preview.url = url;
    preview.state = "running";
    issueEnvironmentChanged({ workspaceId, issueId });
    await preview.done;
  } catch (error) {
    preview.control.abort();
    await preview.done?.catch(() => {});
    preview.state = "failed";
    preview.error = String(error);
  } finally {
    if (port !== undefined) leasedPorts.delete(port);
    delete preview.url;
    issueEnvironmentChanged({ workspaceId, issueId });
  }
}
