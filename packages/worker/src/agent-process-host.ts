/**
 * Runs an agent CLI for an SDK that takes only an executable path (Codex's
 * codexPathOverride; see codexAgentExecutable): the launcher the SDK starts
 * execs this host with the worker's agent process registry and the CLI.
 *
 * The CLI gets this host's stdin, stdout and stderr (the SDK's pipes), leads
 * a process group of its own and is recorded as the worker's agent process
 * (agent-processes.ts). A stop signal from the SDK (a canceled turn) goes to
 * the CLI's whole group: Codex runs one process per turn, so that stops what
 * the turn started, and nothing it started is left holding the SDK's pipes.
 * The host ends as the CLI does. If the worker goes away (the host's parent
 * changes), the group is killed.
 */
import { spawn } from "node:child_process";
import {
  forgetAgentProcess,
  processIdentity,
  recordAgentProcess,
} from "./agent-processes.js";
import { signalChildGroup, signalProcessGroup } from "./process-group.js";
import { errorMessage } from "./utils.js";

const [registry, command, ...args] = process.argv.slice(2);
if (!registry || !command) {
  console.error("usage: agent-process-host <registry> <command> [args...]");
  process.exit(2);
}
const worker = process.ppid;
const workerIdentity = processIdentity(worker);
const child = spawn(command, args, { stdio: "inherit", detached: true });
const pid = child.pid;
if (pid && workerIdentity) {
  try {
    recordAgentProcess(registry, pid, [command, ...args], {
      pid: worker,
      startTime: workerIdentity.startTime,
    });
  } catch (error) {
    console.error(
      `Recording agent process ${pid} failed: ${errorMessage(error)}`,
    );
  }
}

const running = (): boolean =>
  child.exitCode === null && child.signalCode === null;
const stopSignals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
const forward = (signal: NodeJS.Signals): void => {
  if (running()) signalChildGroup(child, signal);
};
for (const signal of stopSignals) process.on(signal, forward);

const watchdog = setInterval(() => {
  if (process.ppid === worker) return;
  if (pid) {
    signalProcessGroup(pid, "SIGKILL");
    forgetAgentProcess(registry, pid);
  }
  process.exit(1);
}, 500);
watchdog.unref();

child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 127;
});
child.once("exit", (code, signal) => {
  clearInterval(watchdog);
  if (pid) forgetAgentProcess(registry, pid);
  if (signal) {
    for (const name of stopSignals) process.removeListener(name, forward);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
