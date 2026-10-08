/**
 * Updating the worker at its server's request (Devices → device → Update).
 * The update runs as its own process outside the worker's service: updating
 * restarts that service, which on Linux stops every process in its cgroup and
 * on macOS boots the launchd job out.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { serviceInstalled } from "./service.js";
import {
  holdSelfUpdateLock,
  selfUpdateInProgress,
} from "./self-update-lock.js";
import { foundryStatePath } from "./state-root.js";
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
  const started = selfUpdateInProgress();
  if (started)
    throw new Error(
      `An update is already running on this device (started ${started}).`,
    );
  holdSelfUpdateLock();
  const log = foundryStatePath("logs", "self-update.log");
  mkdirSync(dirname(log), { recursive: true });
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
          ...carriedEnvironment
            .filter((key) => process.env[key] !== undefined)
            .map((key) => `--setenv=${key}=${process.env[key]}`),
          "--property=StandardOutput=append:" + log,
          "--property=StandardError=append:" + log,
          ...command,
        ],
        { detached: true, stdio: ["ignore", output, output] },
      )
    : spawn(command[0]!, command.slice(1), {
        detached: true,
        stdio: ["ignore", output, output],
      });
  child.unref();
  return { log };
}
