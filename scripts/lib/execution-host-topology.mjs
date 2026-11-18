// The execution hosts of one stack, found through that stack's own state root,
// for recovery cases that kill the Worker mid-input (C19). A host runs the
// input's process. Whether it survives the kill decides what the input reports
// after a restart: alive, the restarted Worker adopts the run and it completes;
// gone, the run died and the input is marked lost. Both are correct; the case
// asserts whichever one the topology shows.
//
// Layout (packages/worker/src/execution-host/paths.ts): each host keeps its
// identity in <FOUNDRY_STATE_ROOT>/execution-hosts/<key>/identity.json. On
// macOS the host is a launchd job; its label is found by pid.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function check(condition, message) {
  if (!condition) throw new Error(message);
}

/** The hosts this stack's Worker started, read from its own state root. */
export function executionHosts(stateRoot) {
  const hostsRoot = join(stateRoot, "execution-hosts");
  if (!existsSync(hostsRoot)) return [];
  return readdirSync(hostsRoot)
    .map((key) => join(hostsRoot, key, "identity.json"))
    .filter((path) => existsSync(path))
    .map((path) => {
      const identity = JSON.parse(readFileSync(path, "utf8"));
      check(Number.isInteger(identity.pid), `no pid in ${path}`);
      return { pid: identity.pid, identity: path };
    });
}

/** True while the process exists and is not a zombie. */
export function processAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
  const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
    encoding: "utf8",
  }).trim();
  return state !== "" && !state.startsWith("Z");
}

/** The launchd label of a job whose process has this pid, if any (macOS). */
function launchdLabel(pid) {
  const listed = execFileSync("/bin/launchctl", ["list"], {
    encoding: "utf8",
  });
  const row = listed
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find((columns) => columns[0] === String(pid));
  return row?.[2];
}

/**
 * Stops the hosts this stack started: unloads their launchd jobs on macOS
 * (so launchd does not restart them), signals each pid, and removes its
 * plist from the stack's HOME. Only pids from this stack's state root are
 * touched. Returns a line for the log.
 */
export async function stopExecutionHosts(stateRoot, home) {
  const hosts = executionHosts(stateRoot);
  if (hosts.length === 0) return "no execution host was started";
  const notes = [];
  for (const host of hosts) {
    if (process.platform === "darwin" && processAlive(host.pid)) {
      const label = launchdLabel(host.pid);
      if (label) {
        execFileSync("/bin/launchctl", [
          "bootout",
          `gui/${process.getuid()}/${label}`,
        ]);
        rmSync(join(home, "Library", "LaunchAgents", `${label}.plist`), {
          force: true,
        });
        notes.push(`${label} unloaded`);
      }
    }
    if (!processAlive(host.pid)) {
      notes.push(`host ${host.pid} already gone`);
      continue;
    }
    process.kill(host.pid, "SIGTERM");
    for (let i = 0; i < 10 && processAlive(host.pid); i++) await sleep(500);
    if (processAlive(host.pid)) {
      process.kill(host.pid, "SIGKILL");
      notes.push(`host ${host.pid} needed SIGKILL`);
    }
    check(
      !processAlive(host.pid),
      `execution host ${host.pid} survived SIGKILL`,
    );
    notes.push(`host ${host.pid} stopped`);
  }
  return notes.join("; ");
}
