import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { WorkObservation } from "@bd777/foundry-protocol";
import {
  processIdentity,
  agentProcessRegistry,
  readAgentProcessRecords,
} from "../agent-processes.js";
import { redactSecrets } from "../secret-redaction.js";

export interface DetachedProcess {
  id: string;
  sessionId: string;
  pid: number;
  startTime: string;
  title: string;
}
export interface ProcessSnapshot {
  pid: number;
  parent: number;
  state: string;
  startTime: string;
  executable: string;
}

function snapshot(pid: number): ProcessSnapshot {
  const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const executable =
    fields[0] === "Z"
      ? ""
      : readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0] || "";
  return {
    pid,
    parent: Number(fields[1]),
    state: fields[0]!,
    startTime: `${boot}:${fields[19]}`,
    executable,
  };
}
function nativeRoots(): Set<number> {
  const roots = new Set([process.pid]);
  for (const record of readAgentProcessRecords(agentProcessRegistry()))
    if (processIdentity(record.pid)?.startTime === record.startTime)
      roots.add(record.pid);
  return roots;
}
/** A process group is a job-control boundary, not evidence of background intent.
 * Native helpers and live tool descendants remain owned by their execution. */
export function processRole(
  item: ProcessSnapshot,
  roots: ReadonlySet<number>,
  read: (pid: number) => ProcessSnapshot = snapshot,
): NonNullable<WorkObservation["processRole"]> {
  if (
    roots.has(item.pid) ||
    basename(item.executable) === "codex-code-mode-host"
  )
    return "runtime";
  const seen = new Set<number>();
  let parent = item.parent;
  while (parent > 1 && !seen.has(parent)) {
    if (roots.has(parent)) return "foreground";
    seen.add(parent);
    try {
      parent = read(parent).parent;
    } catch {
      break;
    }
  }
  // Only a genuinely orphaned, attributable process is independently managed.
  // Long-running foreground tools can be their own process group/session too.
  return item.parent === 1 ? "background" : "foreground";
}
function originalIdentity(id: string): { pid: number; startTime: string } {
  const separator = id.indexOf(":");
  const pid = Number(id.slice(0, separator));
  const startTime = id.slice(separator + 1);
  if (separator < 1 || !Number.isSafeInteger(pid) || pid <= 1 || !startTime)
    throw new Error("Invalid external process identity");
  return { pid, startTime };
}

/** Missing, zombie, rebooted or reused identities prove the original process
 * ended. Permission/read errors do not prove exit, and remain unknown. */
export function inspectDetachedProcess(
  id: string,
  read: (pid: number) => ProcessSnapshot = snapshot,
  roots: ReadonlySet<number> = nativeRoots(),
): WorkObservation {
  const { pid, startTime } = originalIdentity(id);
  const at = new Date().toISOString();
  try {
    const current = read(pid);
    if (current.startTime !== startTime || current.state === "Z")
      return { status: "completed", at, endedAt: at, confirmedRevision: 0 };
    return {
      status: "running",
      at,
      confirmedRevision: 0,
      processRole: processRole(current, roots, read),
    };
  } catch (e) {
    if (["ENOENT", "ESRCH"].includes((e as NodeJS.ErrnoException).code || ""))
      return { status: "completed", at, endedAt: at, confirmedRevision: 0 };
    return {
      status: "unknown",
      at,
      confirmedRevision: 0,
      error: "Cannot verify external process identity",
    };
  }
}

/** Session attribution is necessary but insufficient: a live tool invocation
 * inherits the same identity. Only standalone background processes qualify. */
export function discoverDetachedProcesses(
  sessionIds: ReadonlySet<string>,
): DetachedProcess[] {
  if (process.platform !== "linux") return [];
  const roots = nativeRoots();
  const result: DetachedProcess[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    try {
      if (statSync(`/proc/${pid}`).uid !== process.getuid?.()) continue;
      const current = snapshot(pid);
      if (current.state === "Z" || processRole(current, roots) !== "background")
        continue;
      const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
      if (env.some((v) => v.startsWith("FOUNDRY_WORK_ID="))) continue;
      const sessionId = env
        .find((v) => v.startsWith("FOUNDRY_SESSION_ID="))
        ?.slice("FOUNDRY_SESSION_ID=".length);
      if (!sessionId || !sessionIds.has(sessionId)) continue;
      const identity = processIdentity(pid);
      if (!identity || identity.startTime !== current.startTime) continue;
      result.push({
        id: `${pid}:${identity.startTime}`,
        sessionId,
        pid,
        startTime: identity.startTime,
        title: redactSecrets(identity.command).slice(0, 250),
      });
    } catch {
      /* A raced or unreadable process is not a verified candidate. */
    }
  }
  return result;
}

export async function stopDetachedProcess(id: string): Promise<void> {
  const { pid } = originalIdentity(id);
  let actual = inspectDetachedProcess(id);
  if (actual.status === "completed") return; // An exit/reused PID is idempotent.
  if (actual.status !== "running" || actual.processRole !== "background")
    throw new Error(
      "Not a verified standalone background process; refusing to signal a foreground tool or agent runtime",
    );
  process.kill(pid, "SIGTERM");
  const until = Date.now() + 2500;
  while (Date.now() < until) {
    actual = inspectDetachedProcess(id);
    if (actual.status === "completed") return;
    if (actual.status !== "running" || actual.processRole !== "background")
      throw new Error(
        "External process identity became unverified during stop",
      );
    await new Promise((r) => setTimeout(r, 50));
  }
  // Recheck both identity and classification immediately before escalation.
  actual = inspectDetachedProcess(id);
  if (actual.status === "completed") return;
  if (actual.status !== "running" || actual.processRole !== "background")
    throw new Error("External process is not safe to signal");
  process.kill(pid, "SIGKILL");
  for (let n = 0; n < 20; n++) {
    if (inspectDetachedProcess(id).status === "completed") return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("External process termination is still pending");
}
