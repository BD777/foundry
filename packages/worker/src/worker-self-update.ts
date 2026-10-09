/**
 * Updating the worker at its server's request (Devices → device → Update).
 * The update runs as its own process outside the worker's service: updating
 * restarts that service, which on Linux stops every process in its cgroup and
 * on macOS boots the launchd job out.
 */

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { serviceInstalled } from "./service.js";
import {
  holdSelfUpdateLock,
  selfUpdateInProgress,
} from "./self-update-lock.js";
import {
  readWorkerUpdateStatus,
  selfUpdateLogMarker,
  selfUpdateLogPath,
  selfUpdateStatusPath,
  selfUpdateStatusVariable,
  writeSelfUpdateRecord,
  type WorkerUpdateStatus,
} from "./self-update-status.js";
import { currentRuntimeCli, currentRuntimeVersion } from "./worker-install.js";
import { ownPackage } from "./worker-identity.js";

/** Environment the update needs to find this stack, npm and the agents. */
const carriedEnvironment = [
  "HOME",
  "PATH",
  "USER",
  "LANG",
  "FOUNDRY_STACK",
  "FOUNDRY_STATE_ROOT",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
];

/**
 * Starts `update --server <serverURL>` detached and returns the log it writes.
 * Throws when this worker was not set up with `install` (a source checkout
 * updates with git).
 */
export function startSelfUpdate(serverURL: string): { log: string } {
  const { name } = ownPackage();
  if (!currentRuntimeVersion(name) || !serviceInstalled())
    throw new Error(
      "This worker was not installed with `install` (for example it runs from a source checkout), so it cannot update itself; update it on the device.",
    );
  // An update that died without a word leaves its lock behind.
  const started = selfUpdateInProgress();
  if (started && readWorkerUpdateStatus().state === "running")
    throw new Error(
      `An update is already running on this device (started ${started}).`,
    );
  const startedAt = new Date();
  holdSelfUpdateLock(startedAt);
  const log = selfUpdateLogPath();
  mkdirSync(dirname(log), { recursive: true });
  appendFileSync(
    log,
    `\n${selfUpdateLogMarker}${startedAt.toISOString()} ===\n`,
  );
  // Written before the update runs, so a status probe never finds an update
  // that has not started yet as one that ended without a word.
  const status = selfUpdateStatusPath();
  writeSelfUpdateRecord(
    {
      state: "running",
      step: "starting",
      startedAt: startedAt.toISOString(),
      updatedAt: startedAt.toISOString(),
    },
    status,
  );
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    [selfUpdateStatusVariable]: status,
  };
  const command = [
    process.execPath,
    currentRuntimeCli(name),
    "update",
    "--server",
    serverURL,
  ];
  const output = openSync(log, "a");
  const systemdRun =
    process.platform === "linux" &&
    spawnSync("systemd-run", ["--user", "--version"], { stdio: "ignore" })
      .status === 0;
  const child = systemdRun
    ? spawn(
        "systemd-run",
        [
          "--user",
          "--collect",
          "--quiet",
          `--unit=foundry-worker-update-${Date.now()}`,
          ...[...carriedEnvironment, selfUpdateStatusVariable]
            .filter((key) => environment[key] !== undefined)
            .map((key) => `--setenv=${key}=${environment[key]}`),
          "--property=StandardOutput=append:" + log,
          "--property=StandardError=append:" + log,
          ...command,
        ],
        { detached: true, stdio: ["ignore", output, output] },
      )
    : spawn(command[0]!, command.slice(1), {
        detached: true,
        env: environment,
        stdio: ["ignore", output, output],
      });
  child.unref();
  return { log };
}

const failurePollMs = 2_000;
const failureWatchMs = 16 * 60_000;

/**
 * Watches the update just started and calls `report` once if it fails or
 * ends without a word, so the server hears it within seconds rather than at
 * its next status probe. Success needs no report: the worker restarts on the
 * new version.
 */
export function watchSelfUpdateFailure(
  report: (status: WorkerUpdateStatus) => void,
  pollMs = failurePollMs,
): () => void {
  const started = Date.now();
  const timer = setInterval(() => {
    const status = readWorkerUpdateStatus();
    if (status.state === "running" && Date.now() - started < failureWatchMs)
      return;
    clearInterval(timer);
    if (status.state === "failed" || status.state === "none") report(status);
  }, pollMs);
  timer.unref();
  return () => clearInterval(timer);
}
