/**
 * Issue lifecycle — review decisions, execution workspaces,
 * preview management, and issue execution.
 */

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type {
  DeviceProjection,
  Issue,
  RunEvent,
  WorkspaceProjection,
} from "@foundry/protocol";
import { writeJSON } from "./storage.js";
import { sleep } from "./utils.js";
import { getDevice } from "./device.js";
import { getJSON } from "./transport.js";
import { readWorkspace } from "./workspaces.js";
export { executeIssue } from "./issue-execution.js";

// --- Types ---

export interface ReviewRecord {
  issueId: string;
  shortId: string;
  decision: "awaiting_review" | "accepted" | "changes_requested";
  artifact?: {
    id: string;
    kind: string;
    primaryUri?: string;
    summary: string;
    title: string;
  };
  integration?: IntegrationRecord;
  preview?: PreviewRecord;
  syncedAt: string;
}

export interface ExecutionRecord {
  branchName?: string;
  createdAt: string;
  executionWorkspacePath: string;
  mode: "git_worktree" | "workspace";
  patchPath?: string;
  rootWorkspacePath: string;
  runId: string;
}

export interface IntegrationRecord {
  detail: string;
  patchPath?: string;
  status:
    | "already_in_workspace"
    | "already_applied"
    | "applied_patch"
    | "failed"
    | "no_patch";
  syncedAt: string;
  worktreePath?: string;
}

export interface PreviewConfig {
  command: string;
  host?: string;
  portEnd?: number;
  portStart?: number;
  readyPath?: string;
  readyTimeoutMs?: number;
}

export interface PreviewRecord {
  command: string;
  cwd: string;
  issueId: string;
  pid: number;
  port: number;
  ready: boolean;
  runId: string;
  startedAt: string;
  stderrPath: string;
  stdoutPath: string;
  stoppedAt?: string;
  url: string;
}

export function issueBelongsToWorkspace(
  workspacePath: string,
  issue: Issue,
): boolean {
  if (
    existsSync(
      resolve(workspacePath, ".foundry", "issues", `${issue.shortId}.json`),
    )
  ) {
    return true;
  }
  if (
    issue.artifact?.primaryUri &&
    resolve(issue.artifact.primaryUri).startsWith(workspacePath)
  ) {
    return true;
  }
  return false;
}

export function reviewDecision(
  issue: Issue,
): ReviewRecord["decision"] | undefined {
  if (!issue.artifact) {
    return undefined;
  }
  if (issue.status === "verifying") {
    return "awaiting_review";
  }
  if (issue.status === "accepted") {
    return "accepted";
  }
  if (
    issue.status === "pending" &&
    issue.checks.includes("Changes requested")
  ) {
    return "changes_requested";
  }
  return undefined;
}

export function safeArtifactName(issue: Issue): string {
  return `${issue.shortId}-${issue.title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 96);
}

export function mirrorAcceptedArtifact(
  workspacePath: string,
  issue: Issue,
): string | undefined {
  if (!issue.artifact?.primaryUri) {
    return undefined;
  }
  const source = resolve(issue.artifact.primaryUri);
  if (!source.startsWith(workspacePath) || !existsSync(source)) {
    return undefined;
  }
  const acceptedPath = resolve(
    workspacePath,
    "accepted",
    `${safeArtifactName(issue)}.md`,
  );
  mkdirSync(dirname(acceptedPath), { recursive: true });
  copyFileSync(source, acceptedPath);
  return acceptedPath;
}

type RecordRunEvent = (
  label: string,
  detail: string,
  level?: RunEvent["level"],
) => Promise<void>;

export function runGitCommand(
  workspacePath: string,
  args: string[],
): { ok: boolean; status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    cwd: workspacePath,
    encoding: "utf8",
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function readExecutionRecord(
  workspacePath: string,
  issue: Issue,
): ExecutionRecord | undefined {
  if (!issue.run?.id) {
    return undefined;
  }
  const path = resolve(
    workspacePath,
    ".foundry",
    "runs",
    issue.run.id,
    "execution.json",
  );
  if (!existsSync(path)) {
    return undefined;
  }
  return JSON.parse(readFileSync(path, "utf8")) as ExecutionRecord;
}

export function patchHasDiff(
  patchPath: string | undefined,
): patchPath is string {
  if (!patchPath || !existsSync(patchPath)) {
    return false;
  }
  const patch = readFileSync(patchPath, "utf8").trim();
  return patch !== "" && patch !== "no tracked-file diff";
}

export function cleanupWorktree(
  workspacePath: string,
  execution: ExecutionRecord,
): void {
  if (execution.mode !== "git_worktree") {
    return;
  }
  const worktreeRoot = resolve(workspacePath, ".foundry", "worktrees");
  const executionPath = resolve(execution.executionWorkspacePath);
  if (executionPath.startsWith(worktreeRoot) && existsSync(executionPath)) {
    runGitCommand(workspacePath, [
      "worktree",
      "remove",
      "--force",
      executionPath,
    ]);
  }
  if (execution.branchName) {
    runGitCommand(workspacePath, ["branch", "-D", execution.branchName]);
  }
}

export function integrateAcceptedIssue(
  workspacePath: string,
  issue: Issue,
): IntegrationRecord | undefined {
  const execution = readExecutionRecord(workspacePath, issue);
  if (!execution) {
    return undefined;
  }

  const syncedAt = new Date().toISOString();
  const integrationPath = resolve(
    workspacePath,
    ".foundry",
    "integrations",
    `${issue.shortId}.json`,
  );
  let integration: IntegrationRecord;

  if (execution.mode === "workspace") {
    integration = {
      detail: "Provider already ran in the main workspace.",
      status: "already_in_workspace",
      syncedAt,
    };
    writeJSON(integrationPath, integration);
    return integration;
  }

  if (!patchHasDiff(execution.patchPath)) {
    cleanupWorktree(workspacePath, execution);
    integration = {
      detail: "Accepted issue had no git patch to apply.",
      patchPath: execution.patchPath,
      status: "no_patch",
      syncedAt,
      worktreePath: execution.executionWorkspacePath,
    };
    writeJSON(integrationPath, integration);
    return integration;
  }

  const alreadyApplied = runGitCommand(workspacePath, [
    "apply",
    "--reverse",
    "--check",
    execution.patchPath,
  ]);
  if (alreadyApplied.ok) {
    cleanupWorktree(workspacePath, execution);
    integration = {
      detail: "Patch was already present in the main workspace.",
      patchPath: execution.patchPath,
      status: "already_applied",
      syncedAt,
      worktreePath: execution.executionWorkspacePath,
    };
    writeJSON(integrationPath, integration);
    return integration;
  }

  const check = runGitCommand(workspacePath, [
    "apply",
    "--check",
    execution.patchPath,
  ]);
  if (!check.ok) {
    integration = {
      detail: check.stderr.trim() || "git apply --check failed",
      patchPath: execution.patchPath,
      status: "failed",
      syncedAt,
      worktreePath: execution.executionWorkspacePath,
    };
    writeJSON(integrationPath, integration);
    return integration;
  }

  const applied = runGitCommand(workspacePath, ["apply", execution.patchPath]);
  integration = {
    detail: applied.ok
      ? "Patch applied to the main workspace."
      : applied.stderr.trim(),
    patchPath: execution.patchPath,
    status: applied.ok ? "applied_patch" : "failed",
    syncedAt,
    worktreePath: execution.executionWorkspacePath,
  };
  if (applied.ok) {
    cleanupWorktree(workspacePath, execution);
  }
  writeJSON(integrationPath, integration);
  return integration;
}

export function readPreviewConfig(
  workspacePath: string,
): PreviewConfig | undefined {
  const configPath = resolve(workspacePath, ".foundry", "preview.json");
  if (!existsSync(configPath)) {
    return undefined;
  }
  const config = JSON.parse(readFileSync(configPath, "utf8")) as PreviewConfig;
  if (!config.command || config.command.trim() === "") {
    throw new Error(`${configPath} must include a preview command`);
  }
  return config;
}

export function isPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolveCheck) => {
    const server = createServer();
    server.once("error", () => resolveCheck(false));
    server.once("listening", () => {
      server.close(() => resolveCheck(true));
    });
    server.listen(port, host);
  });
}

export async function allocatePreviewPort(
  config: PreviewConfig,
): Promise<number> {
  const host = config.host ?? "127.0.0.1";
  const start = config.portStart ?? 4300;
  const end = config.portEnd ?? start + 99;
  for (let port = start; port <= end; port += 1) {
    if (await isPortAvailable(host, port)) {
      return port;
    }
  }
  throw new Error(`No preview port available in ${start}-${end}`);
}

export async function waitForPreview(
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

export async function startPreviewIfConfigured(
  rootWorkspacePath: string,
  executionWorkspacePath: string,
  issue: Issue,
  runID: string,
  runDir: string,
  record: RecordRunEvent,
): Promise<PreviewRecord | undefined> {
  const config = readPreviewConfig(rootWorkspacePath);
  if (!config) {
    return undefined;
  }

  const host = config.host ?? "127.0.0.1";
  const port = await allocatePreviewPort(config);
  const readyPath = config.readyPath ?? "/";
  const url = `http://${host}:${port}${readyPath}`;
  const stdoutPath = resolve(runDir, "preview.stdout.log");
  const stderrPath = resolve(runDir, "preview.stderr.log");
  writeFileSync(stdoutPath, "");
  writeFileSync(stderrPath, "");
  const stdout = openSync(stdoutPath, "a");
  const stderr = openSync(stderrPath, "a");

  const child = spawn("sh", ["-lc", config.command], {
    cwd: executionWorkspacePath,
    detached: true,
    env: {
      ...process.env,
      FOUNDRY_PREVIEW_PORT: String(port),
      FOUNDRY_ROOT_WORKSPACE: rootWorkspacePath,
      FOUNDRY_RUN_DIR: runDir,
      FOUNDRY_WORKSPACE: executionWorkspacePath,
    },
    stdio: ["ignore", stdout, stderr],
  });
  closeSync(stdout);
  closeSync(stderr);
  child.unref();

  const preview: PreviewRecord = {
    command: config.command,
    cwd: executionWorkspacePath,
    issueId: issue.id,
    pid: child.pid ?? 0,
    port,
    ready: false,
    runId: runID,
    startedAt: new Date().toISOString(),
    stderrPath,
    stdoutPath,
    url,
  };
  await record("Started local preview", url);

  preview.ready = await waitForPreview(url, config.readyTimeoutMs ?? 15000);
  writeJSON(resolve(runDir, "preview.json"), preview);
  await record(
    preview.ready ? "Preview ready" : "Preview not ready",
    preview.ready ? url : `${url} did not respond before timeout`,
    preview.ready ? "info" : "warning",
  );
  return preview;
}

export function stopPreviewForIssue(
  workspacePath: string,
  issue: Issue,
): PreviewRecord | undefined {
  if (!issue.run?.id) {
    return undefined;
  }
  const previewPath = resolve(
    workspacePath,
    ".foundry",
    "runs",
    issue.run.id,
    "preview.json",
  );
  if (!existsSync(previewPath)) {
    return undefined;
  }
  const preview = JSON.parse(
    readFileSync(previewPath, "utf8"),
  ) as PreviewRecord;
  if (!preview.pid || preview.stoppedAt) {
    return preview;
  }
  try {
    process.kill(-preview.pid, "SIGTERM");
  } catch {
    try {
      process.kill(preview.pid, "SIGTERM");
    } catch {
      // The preview process may already be gone.
    }
  }
  preview.stoppedAt = new Date().toISOString();
  writeJSON(previewPath, preview);
  return preview;
}

export function workspaceProjectionForPath(
  workspacePath: string,
  device: DeviceProjection,
): WorkspaceProjection {
  const workspace = readWorkspace(workspacePath);
  return {
    id: workspace.id,
    name: workspace.name,
    localPath: workspace.path,
    baseline: workspace.baseline,
    contextSummary: "Local Foundry workspace registered by foundry-worker.",
    acceptedCount: 0,
    resolvedCount: 0,
    deviceId: device.id,
    deviceLabel: device.label,
  };
}

export async function syncReviews(
  serverURL: string,
  workspacePath: string,
): Promise<number> {
  const workspace = workspaceProjectionForPath(workspacePath, getDevice());
  const issues = await getJSON<Issue[]>(
    serverURL,
    `/api/issues?workspaceId=${encodeURIComponent(workspace.id)}`,
  );
  let synced = 0;
  for (const issue of issues) {
    if (!issueBelongsToWorkspace(workspacePath, issue)) {
      continue;
    }
    const decision = reviewDecision(issue);
    if (!decision) {
      continue;
    }
    const acceptedArtifactPath =
      decision === "accepted"
        ? mirrorAcceptedArtifact(workspacePath, issue)
        : undefined;
    const integration =
      decision === "accepted"
        ? integrateAcceptedIssue(workspacePath, issue)
        : undefined;
    const preview =
      decision === "accepted" || decision === "changes_requested"
        ? stopPreviewForIssue(workspacePath, issue)
        : undefined;
    const record: ReviewRecord = {
      issueId: issue.id,
      shortId: issue.shortId,
      decision,
      artifact: issue.artifact
        ? {
            id: issue.artifact.id,
            kind: issue.artifact.kind,
            primaryUri: acceptedArtifactPath ?? issue.artifact.primaryUri,
            summary: issue.artifact.summary,
            title: issue.artifact.title,
          }
        : undefined,
      integration,
      preview,
      syncedAt: new Date().toISOString(),
    };
    writeJSON(
      resolve(workspacePath, ".foundry", "reviews", `${issue.shortId}.json`),
      record,
    );
    synced += 1;
  }
  console.log(`Synced ${synced} review decision${synced === 1 ? "" : "s"}.`);
  return synced;
}
