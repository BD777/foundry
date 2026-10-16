/**
 * Agent CLI processes (Claude Code, Codex, a profile's own command) die with
 * the worker that started them.
 *
 * Started by the daemon, each agent CLI leads a process group of its own, so
 * stopping the group stops every tool it started, and is recorded in the
 * worker's state (agent-processes/<pid>.json) with its start time and command
 * line. When the worker exits or is told to stop, it stops the groups it
 * recorded. A worker that could not (killed, crashed) leaves them running
 * with nobody reading their output, so the next worker stops what the
 * previous one recorded before it takes any work: only a process whose start
 * time and command line are still the recorded ones, whose worker is gone.
 * The new turn then resumes the agent's native session.
 *
 * Codex's SDK only takes an executable path, so its CLI starts through
 * agent-process-host, which records it and stops it if the worker goes away.
 *
 * Outside the daemon (a sandboxed session host, a CLI command, tests) agent
 * processes start as they always did: a sandboxed host is itself a process
 * group that dies with the worker (process-group.ts).
 */

import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { signalProcessGroup } from "./process-group.js";
import { foundryStatePath } from "./state-root.js";
import { writeFileAtomic, writePrivateJSONAtomic } from "./storage.js";
import { errorMessage } from "./utils.js";

/** A running process as the system reports it. */
export interface ProcessIdentity {
  /**
   * When it started (with the boot on Linux): no two processes that ever
   * had one pid share it.
   */
  startTime: string;
  /** Its command line, arguments joined by spaces. */
  command: string;
}

/** One recorded agent process, the leader of its own process group. */
export interface AgentProcessRecord {
  pid: number;
  startTime: string;
  /** The command line it was started with. */
  argv: string[];
  /** The worker that started it. */
  owner: { pid: number; startTime: string };
}

/** The folder of agent process records in the worker's state. */
export function agentProcessRegistry(): string {
  return foundryStatePath("agent-processes");
}

let linuxBootId: string | undefined;

/**
 * The identity of a running process, or undefined when there is none (or
 * it is not readable). Two processes with one pid never share it.
 */
export function processIdentity(pid: number): ProcessIdentity | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // Fields after the command name, which may hold spaces: state is the
      // first (field 3), the start time in clock ticks since boot field 22.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z") return undefined;
      linuxBootId ??= readFileSync(
        "/proc/sys/kernel/random/boot_id",
        "utf8",
      ).trim();
      const command = readFileSync(`/proc/${pid}/cmdline`, "utf8")
        .replace(/\0$/, "")
        .split("\0")
        .join(" ");
      return { startTime: `${linuxBootId}:${fields[19]}`, command };
    } catch {
      return undefined;
    }
  }
  // macOS: ps, with a fixed zone and locale so the time reads the same later.
  const ps = (column: string): string =>
    spawnSync("/bin/ps", ["-ww", "-o", `${column}=`, "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      timeout: 5000,
    }).stdout?.trim() ?? "";
  const startTime = ps("lstart");
  const command = ps("command");
  return startTime && command ? { startTime, command } : undefined;
}

/**
 * Whether the recorded process still runs: the same start time, and the
 * command line it was started with. An interpreter a script names (or env
 * finding it) may stand before that command line; the arguments end it.
 */
function stillRuns(record: AgentProcessRecord): boolean {
  const live = processIdentity(record.pid);
  if (!live || live.startTime !== record.startTime) return false;
  const [program = "", ...args] = record.argv;
  return args.length > 0
    ? live.command.endsWith(` ${args.join(" ")}`)
    : live.command.includes(basename(program));
}

/**
 * Records pid, just started with argv by the worker owner, as an agent
 * process.
 */
export function recordAgentProcess(
  registry: string,
  pid: number,
  argv: string[],
  owner: { pid: number; startTime: string },
): void {
  const identity = processIdentity(pid);
  if (!identity) return; // Already gone.
  const record: AgentProcessRecord = {
    pid,
    startTime: identity.startTime,
    argv,
    owner,
  };
  writePrivateJSONAtomic(resolve(registry, `${pid}.json`), record, {
    hardenParent: false,
    fsync: false,
  });
}

export function forgetAgentProcess(registry: string, pid: number): void {
  rmSync(resolve(registry, `${pid}.json`), { force: true });
}

export function readAgentProcessRecords(
  registry: string,
): AgentProcessRecord[] {
  let names: string[];
  try {
    names = readdirSync(registry);
  } catch {
    return [];
  }
  const records: AgentProcessRecord[] = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const record = JSON.parse(
        readFileSync(resolve(registry, name), "utf8"),
      ) as AgentProcessRecord;
      if (
        Number.isInteger(record.pid) &&
        record.pid > 0 &&
        typeof record.startTime === "string" &&
        Array.isArray(record.argv) &&
        record.argv.every((value) => typeof value === "string") &&
        Number.isInteger(record.owner?.pid) &&
        typeof record.owner?.startTime === "string"
      )
        records.push(record);
    } catch {
      // A record being written, or not one of ours.
    }
  }
  return records;
}

function groupExists(pgid: number): boolean {
  return signalProcessGroup(pgid, 0);
}

/**
 * Stops the recorded agent processes whose worker is gone and which are
 * still the processes recorded, with every process of their groups: TERM,
 * then KILL for what is left after graceMs. Records of anything else are
 * dropped; their pids may belong to someone else by now. Resolves with the
 * pids stopped.
 */
export async function reapLeftoverAgentProcesses(
  registry = agentProcessRegistry(),
  graceMs = 3000,
): Promise<number[]> {
  const reaped: number[] = [];
  for (const record of readAgentProcessRecords(registry)) {
    const owner = processIdentity(record.owner.pid);
    if (owner?.startTime === record.owner.startTime) continue; // Its worker runs.
    if (stillRuns(record)) {
      signalProcessGroup(record.pid, "SIGTERM");
      reaped.push(record.pid);
    }
    forgetAgentProcess(registry, record.pid);
  }
  const deadline = Date.now() + graceMs;
  let left = reaped;
  while (left.length > 0 && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 100));
    left = left.filter(groupExists);
  }
  for (const pid of left) signalProcessGroup(pid, "SIGKILL");
  return reaped;
}

let supervisor: { registry: string; identity: ProcessIdentity } | undefined;

/**
 * Makes this process the supervising worker: agent processes it starts from
 * now on lead their own recorded process groups, which are stopped when it
 * exits or is told to stop, and those a previous worker left are stopped
 * now. Called once by the daemon before it takes work.
 */
export async function superviseAgentProcesses(): Promise<void> {
  if (supervisor) return;
  const identity = processIdentity(process.pid);
  if (!identity) {
    console.error(
      "Agent processes are not supervised: this system does not say when a process started.",
    );
    return;
  }
  supervisor = { registry: agentProcessRegistry(), identity };
  process.on("exit", stopOwnAgentProcessesNow);
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
    process.on(signal, stopOnSignal);
  const reaped = await reapLeftoverAgentProcesses(supervisor.registry);
  if (reaped.length > 0)
    console.log(
      `Stopped ${reaped.length} agent process${reaped.length === 1 ? "" : "es"} a previous worker left running (pid ${reaped.join(", ")}).`,
    );
}

/** The records of agent processes this worker started that still run. */
function ownAgentProcesses(): number[] {
  if (!supervisor) return [];
  const { registry, identity } = supervisor;
  return readAgentProcessRecords(registry)
    .filter(
      (record) =>
        record.owner.pid === process.pid &&
        record.owner.startTime === identity.startTime,
    )
    .map((record) => record.pid);
}

/** On exit nothing can wait for a timer: TERM, a short pause, then KILL. */
function stopOwnAgentProcessesNow(): void {
  const groups = ownAgentProcesses().filter((pid) =>
    signalProcessGroup(pid, "SIGTERM"),
  );
  if (groups.length === 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  for (const pid of groups) signalProcessGroup(pid, "SIGKILL");
  if (supervisor)
    for (const pid of groups) forgetAgentProcess(supervisor.registry, pid);
}

let stopping = false;

/**
 * Told to stop: the agents get TERM and a few seconds to end (their session
 * files stay whole), then KILL; then the signal does what it did before,
 * unless something else in the worker handles it.
 */
function stopOnSignal(signal: NodeJS.Signals): void {
  if (stopping) {
    for (const pid of ownAgentProcesses()) signalProcessGroup(pid, "SIGKILL");
    return;
  }
  stopping = true;
  const groups = ownAgentProcesses().filter((pid) =>
    signalProcessGroup(pid, "SIGTERM"),
  );
  const deadline = Date.now() + 3000;
  const finish = (): void => {
    for (const pid of groups) signalProcessGroup(pid, "SIGKILL");
    if (supervisor)
      for (const pid of groups) forgetAgentProcess(supervisor.registry, pid);
    if (process.listenerCount(signal) > 1) return;
    for (const name of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
      process.removeListener(name, stopOnSignal);
    process.kill(process.pid, signal);
  };
  const check = (): void => {
    if (Date.now() >= deadline || !groups.some(groupExists)) finish();
    else setTimeout(check, 100);
  };
  check();
}

/** Agent processes started as the leaders of their own process groups. */
const groupLeaders = new WeakSet<ChildProcess>();

/**
 * Starts an agent process. Under a supervising worker it leads its own
 * process group and is recorded until it exits; otherwise it starts as any
 * child does.
 */
export function spawnAgentProcess(
  command: string,
  args: string[],
  options: SpawnOptions,
): ChildProcess {
  if (!supervisor) return spawn(command, args, options);
  const { registry, identity } = supervisor;
  // launchd has no Linux cgroup. A guardian shares the native process's
  // group, survives its owner's SIGKILL, and kills the group on reparenting.
  const guarded = process.platform === "darwin";
  const program = guarded ? process.execPath : command;
  const arguments_ = guarded
    ? [
        fileURLToPath(new URL("./process-group-child.js", import.meta.url)),
        "--owner",
        String(process.pid),
        command,
        ...args,
      ]
    : args;
  const child = spawn(program, arguments_, { ...options, detached: true });
  groupLeaders.add(child);
  const pid = child.pid;
  if (pid) {
    try {
      recordAgentProcess(registry, pid, [program, ...arguments_], {
        pid: process.pid,
        startTime: identity.startTime,
      });
    } catch (error) {
      console.error(
        `Recording agent process ${pid} failed: ${errorMessage(error)}`,
      );
    }
    child.once("exit", () => {
      if (guarded) signalProcessGroup(pid, "SIGKILL");
      forgetAgentProcess(registry, pid);
    });
  }
  return child;
}

/**
 * Stops an agent process started by spawnAgentProcess, with what it started
 * when it leads its own group: TERM, then KILL after graceMs.
 */
export function stopAgentProcess(child: ChildProcess, graceMs = 5000): void {
  const pid = child.pid;
  const group = pid !== undefined && groupLeaders.has(child);
  const send = (signal: NodeJS.Signals): void => {
    if (!group || !signalProcessGroup(pid, signal)) child.kill(signal);
  };
  send("SIGTERM");
  const timer = setTimeout(() => {
    const running = child.exitCode === null && child.signalCode === null;
    if (running || (group && groupExists(pid))) send("SIGKILL");
  }, graceMs);
  timer.unref();
}

/** What the Claude Agent SDK's spawnClaudeCodeProcess is given. */
interface ClaudeSpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}

/**
 * The Claude Agent SDK's spawnClaudeCodeProcess under a supervising worker,
 * else undefined (the SDK spawns as it always did). It starts the CLI as the
 * SDK would, as an agent process; stderr goes to onStderr, as the SDK's own
 * spawn would hand it to the stderr option.
 */
export function claudeAgentSpawn(
  onStderr?: (data: string) => void,
): ((options: ClaudeSpawnOptions) => ChildProcess) | undefined {
  if (!supervisor) return undefined;
  return ({ command, args, cwd, env, signal }) => {
    const child = spawnAgentProcess(command, args, {
      cwd,
      env,
      signal,
      stdio: ["pipe", "pipe", onStderr ? "pipe" : "ignore"],
      windowsHide: true,
    });
    child.stderr?.on("data", (data: Buffer) => onStderr?.(data.toString()));
    return child;
  };
}

const hostScript = fileURLToPath(
  new URL("./agent-process-host.js", import.meta.url),
);

/**
 * The executable to hand the Codex SDK for command: under a supervising
 * worker, a launcher that runs it through agent-process-host; else command.
 */
export function codexAgentExecutable(command: string): string {
  if (!supervisor) return command;
  const { registry } = supervisor;
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const script = [
    "#!/bin/sh",
    `exec ${[process.execPath, hostScript, registry, command].map(quote).join(" ")} "$@"`,
    "",
  ].join("\n");
  const name = createHash("sha256").update(script).digest("hex").slice(0, 16);
  const launcher = resolve(registry, `launch-${name}`);
  try {
    if (readFileSync(launcher, "utf8") === script) return launcher;
  } catch {
    // Not written yet.
  }
  try {
    writeFileAtomic(launcher, script, {
      mode: 0o700,
      hardenParent: false,
      fsync: false,
    });
    return launcher;
  } catch (error) {
    console.error(
      `Codex runs unsupervised: writing its launcher failed: ${errorMessage(error)}`,
    );
    return command;
  }
}
