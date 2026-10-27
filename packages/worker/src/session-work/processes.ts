import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { constants } from "node:os";
import type { SessionWork, WorkObservation } from "@bd777/foundry-protocol";
import { processIdentity } from "../agent-processes.js";
import { signalProcessGroup } from "../process-group.js";
import { writePrivateJSONAtomic } from "../storage.js";

interface ProcessRecord {
  pid: number;
  startTime: string;
  generation: number;
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  stopped?: boolean;
  suspended?: boolean;
}

/** Only processes started under an exact work identity may be signalled. */
export class WorkProcesses {
  private records: Record<string, ProcessRecord> = {};
  private children = new Map<string, ChildProcess>();
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    try {
      this.records = JSON.parse(
        readFileSync(join(root, "processes.json"), "utf8"),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  private save() {
    writePrivateJSONAtomic(join(this.root, "processes.json"), this.records);
  }
  async inspect(item: SessionWork): Promise<WorkObservation> {
    const r = this.records[item.id];
    const at = new Date().toISOString();
    if (!r) return { status: "idle", at, confirmedRevision: 0 };
    let identity;
    try {
      identity = processIdentity(r.pid);
    } catch {
      return {
        status: "unknown",
        at,
        confirmedRevision: 0,
        error: "Cannot inspect process identity",
      };
    }
    if (
      identity?.startTime === r.startTime ||
      (!identity && this.groupMembers(r.pid).length > 0)
    )
      return {
        status:
          r.suspended && this.groupSuspended(r.pid) ? "suspended" : "running",
        at,
        confirmedRevision: item.observation.confirmedRevision,
        startedAt: r.startedAt,
      };
    return {
      status: r.stopped
        ? "stopped"
        : r.exitCode === undefined
          ? "unknown"
          : r.exitCode === 0
            ? "completed"
            : "failed",
      at,
      confirmedRevision: item.observation.confirmedRevision,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      exitCode: r.exitCode,
    };
  }
  async start(item: SessionWork, workspacePath: string): Promise<void> {
    if (!item.spec.argv?.length)
      throw new Error("No restartable command definition is recorded");
    const state = (await this.inspect(item)).status;
    if (state === "running") return;
    if (state === "suspended") {
      const r = this.records[item.id]!;
      signalProcessGroup(r.pid, "SIGCONT");
      r.suspended = false;
      r.generation = item.generation;
      this.save();
      return;
    }
    const log = openSync(join(this.root, `${item.id}.log`), "a", 0o600);
    // A new command receives a minimal environment. Session and provider tokens
    // must never be inherited by a background command or persisted with it.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: process.env.LANG,
      TMPDIR: process.env.TMPDIR,
      FOUNDRY_WORK_ID: item.id,
    };
    let child: ChildProcess;
    try {
      child = spawn(item.spec.argv[0]!, item.spec.argv.slice(1), {
        cwd: item.spec.cwd || workspacePath,
        env,
        detached: true,
        stdio: ["ignore", log, log],
      });
    } finally {
      closeSync(log);
    }
    let record: ProcessRecord | undefined;
    let ended:
      { code: number | null; signal: NodeJS.Signals | null } | undefined;
    const saveExit = () => {
      if (!record || !ended) return;
      record.endedAt = new Date().toISOString();
      record.exitCode =
        ended.code ??
        (ended.signal ? 128 + constants.signals[ended.signal] : undefined);
      this.children.delete(item.id);
      this.save();
    };
    const finished = new Promise<void>((resolve) =>
      child.once("exit", (code, signal) => {
        ended = { code, signal };
        saveExit();
        resolve();
      }),
    );
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    const identity = processIdentity(child.pid!);
    if (!identity) {
      // /bin/true and other short commands can exit before /proc is read.
      // Their own child-exit receipt remains authoritative.
      const exited = await Promise.race([
        finished.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 200)),
      ]);
      if (!exited) {
        child.kill("SIGKILL");
        throw new Error("Cannot establish background process identity");
      }
    }
    record = {
      pid: child.pid!,
      startTime: identity?.startTime || "",
      generation: item.generation,
      startedAt: new Date().toISOString(),
    };
    this.records[item.id] = record;
    this.children.set(item.id, child);
    this.save();
    saveExit();
  }
  async stop(item: SessionWork): Promise<void> {
    const r = this.records[item.id];
    if (!r || r.stopped) return;
    const identity = processIdentity(r.pid);
    if (identity && identity.startTime !== r.startTime)
      throw new Error(
        "Process identity changed; refusing to signal a reused PID",
      );
    if (!identity && this.groupMembers(r.pid).length === 0) {
      // Exact leader identity is gone and its entire group is empty. The exit
      // code may be lost across a host restart, but cessation is verified.
    } else {
      signalProcessGroup(r.pid, "SIGCONT");
      signalProcessGroup(r.pid, "SIGTERM");
      const wait = async (ms: number) => {
        const deadline = Date.now() + ms;
        while (this.groupMembers(r.pid).length > 0 && Date.now() < deadline)
          await new Promise((r) => setTimeout(r, 50));
      };
      await wait(1500);
      if (this.groupMembers(r.pid).length > 0) {
        signalProcessGroup(r.pid, "SIGKILL");
        await wait(1500);
      }
      if (this.groupMembers(r.pid).length > 0)
        throw new Error("Process group has not exited after termination");
    }
    r.stopped = true;
    r.endedAt = new Date().toISOString();
    this.save();
  }
  private groupMembers(pgid: number): string[][] {
    const result = spawnSync("ps", ["-axo", "pid=,pgid=,stat="], {
      encoding: "utf8",
      timeout: 3000,
    });
    if (result.status !== 0) throw new Error("Cannot inspect process group");
    const members = result.stdout
      .split("\n")
      .map((l) => l.trim().split(/\s+/))
      .filter((p) => Number(p[1]) === pgid && !p[2]?.includes("Z"));
    return members;
  }
  private groupSuspended(pgid: number): boolean {
    const members = this.groupMembers(pgid);
    return members.length > 0 && members.every((p) => p[2]?.includes("T"));
  }
  async pause(item: SessionWork): Promise<void> {
    const r = this.records[item.id];
    if (!r || r.stopped) return; // A paused definition is not (re)started.
    if (processIdentity(r.pid)?.startTime !== r.startTime) {
      // It already exited, e.g. a service that failed: nothing to suspend.
      if (this.groupMembers(r.pid).length === 0) return;
      throw new Error("No live supervised process to pause");
    }
    signalProcessGroup(r.pid, "SIGSTOP");
    if (!this.groupSuspended(r.pid))
      throw new Error("Process group suspension was not verified");
    r.suspended = true;
    this.save();
  }
  logPath(id: string): string {
    return join(this.root, `${id}.log`);
  }
}
