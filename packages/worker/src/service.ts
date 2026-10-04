/**
 * Service installation — launchd (macOS) and systemd (Linux) setup.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DaemonConfig } from "./config.js";
import { daemonConfigPath, readDaemonConfig } from "./config.js";
import { ensureWorkerApp, workerLauncherScript } from "./mac-worker-app.js";
import { daemonLockHolder } from "./device-pairing.js";
import { optionEnabled } from "./utils.js";
import {
  foundryStackSuffix,
  foundryStatePath,
  foundryStateRoot,
} from "./state-root.js";

export const daemonLogDir = foundryStatePath("logs");

// Every service name and path carries the stack, so installing one stack's
// service never replaces or watches another's.
export function serviceLabel(): string {
  return `dev.foundry${foundryStackSuffix()}.worker`;
}

export function watchdogLabel(): string {
  return `${serviceLabel()}-watchdog`;
}

function systemdUnitName(): string {
  return `foundry-worker${foundryStackSuffix()}.service`;
}

/** The variables that select this stack; a service must run with them. */
function stackEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["FOUNDRY_STACK", "FOUNDRY_STATE_ROOT"]) {
    const value = process.env[key]?.trim();
    if (value) env[key] = value;
  }
  return env;
}

export function serviceLogPaths(): { err: string; out: string } {
  return {
    err: resolve(daemonLogDir, "daemon.err.log"),
    out: resolve(daemonLogDir, "daemon.out.log"),
  };
}

/**
 * How the service runs the worker: the CLI to start (by default the one that
 * is running now; `install` passes the installed runtime's), and on macOS
 * whether Foundry Worker.app hosts it so privacy grants name Foundry.
 */
export interface ServiceHost {
  cliPath?: string;
  macApp?: boolean;
}

export function serviceArgs(config: DaemonConfig, cliPath?: string): string[] {
  return [
    cliPath ?? process.argv[1] ?? "foundry-worker",
    "daemon",
    "--server",
    config.serverURL,
    "--workspace",
    config.workspacePath,
  ];
}

export function serviceEnvironment(): Record<string, string> {
  const user = process.env.USER ?? basename(homedir());
  const env: Record<string, string> = {
    ...stackEnvironment(),
    HOME: homedir(),
    LOGNAME: process.env.LOGNAME ?? user,
    PATH:
      process.env.PATH ??
      [
        resolve(homedir(), ".local", "bin"),
        dirname(process.execPath),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
      ].join(":"),
    SHELL: process.env.SHELL ?? "/bin/bash",
    USER: user,
  };

  for (const key of [
    "CODEX_CLI_PATH",
    "CODEX_HOME",
    "FOUNDRY_CLAUDE_BIN",
    "FOUNDRY_CLAUDE_MAX_TURNS",
    "FOUNDRY_CODEX_BIN",
  ]) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }

  return env;
}

export function environmentVariablesXML(): string {
  return Object.entries(serviceEnvironment())
    .map(
      ([key, value]) =>
        `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`,
    )
    .join("\n");
}

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function launchdPlistPath(): string {
  return resolve(
    homedir(),
    "Library",
    "LaunchAgents",
    `${serviceLabel()}.plist`,
  );
}

export function systemdUnitPath(): string {
  return resolve(homedir(), ".config", "systemd", "user", systemdUnitName());
}

export function bestEffort(command: string, args: string[]): boolean {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    console.error(
      `Warning: ${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`,
    );
  }
  return result.status === 0;
}

/** Installs the login service; says whether the worker is now running. */
export function installService(
  args: string[],
  host: ServiceHost = {},
): boolean {
  const config = readDaemonConfig();
  if (!config) {
    throw new Error(
      "Run foundry-worker pair --server <url> --workspace <path> before install-service.",
    );
  }
  const noStart = optionEnabled(args, "--no-start");
  mkdirSync(daemonLogDir, { recursive: true });
  const logs = serviceLogPaths();

  if (process.platform === "darwin") {
    const plistPath = launchdPlistPath();
    mkdirSync(dirname(plistPath), { recursive: true });
    const command = [process.execPath, ...serviceArgs(config, host.cliPath)];
    const appExecutable = host.macApp
      ? ensureWorkerApp(
          workerLauncherScript({ command, env: serviceEnvironment(), logs }),
        )
      : undefined;
    const argsXML = (appExecutable ? [appExecutable] : command)
      .map((value) => `    <string>${xmlEscape(value)}</string>`)
      .join("\n");
    writeFileSync(
      plistPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${serviceLabel()}</string>
  <key>ProgramArguments</key>
  <array>
${argsXML}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logs.out)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logs.err)}</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(config.workspacePath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${environmentVariablesXML()}
  </dict>
</dict>
</plist>
`,
    );
    if (!noStart && typeof process.getuid === "function") {
      const target = `gui/${process.getuid()}`;
      // Nothing to boot out on a fresh install; not worth a warning.
      spawnSync("launchctl", ["bootout", target, plistPath]);
      bestEffort("launchctl", ["bootstrap", target, plistPath]);
      bestEffort("launchctl", ["enable", `${target}/${serviceLabel()}`]);
      bestEffort("launchctl", [
        "kickstart",
        "-k",
        `${target}/${serviceLabel()}`,
      ]);
    }
    console.log(`Installed launchd service: ${plistPath}`);

    // Install the watchdog agent — checks daemon heartbeat every 60s
    // and kills the daemon if the event loop is blocked (>5min stale).
    const watchdogPath = resolve(
      dirname(plistPath),
      `${watchdogLabel()}.plist`,
    );
    const watchdogScript = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "scripts",
      "watchdog.sh",
    );
    writeFileSync(
      watchdogPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${watchdogLabel()}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>${xmlEscape(watchdogScript)}</string>
    <string>${xmlEscape(foundryStateRoot())}</string>
    <string>${xmlEscape(serviceLabel())}</string>
  </array>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logs.out)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logs.err)}</string>
</dict>
</plist>
`,
    );
    if (!noStart && typeof process.getuid === "function") {
      const target = `gui/${process.getuid()}`;
      spawnSync("launchctl", ["bootout", target, watchdogPath]);
      bestEffort("launchctl", ["bootstrap", target, watchdogPath]);
      bestEffort("launchctl", ["enable", `${target}/${watchdogLabel()}`]);
    }
    console.log(`Installed watchdog: ${watchdogPath}`);
    return !noStart;
  }

  if (process.platform === "linux") {
    const unitPath = systemdUnitPath();
    mkdirSync(dirname(unitPath), { recursive: true });
    const command = [process.execPath, ...serviceArgs(config, host.cliPath)]
      .map((value) => `'${value.replace(/'/g, "'\\''")}'`)
      .join(" ");
    writeFileSync(
      unitPath,
      `[Unit]
Description=Foundry local worker daemon
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${config.workspacePath}
ExecStart=${command}
${Object.entries(stackEnvironment())
  .map(([key, value]) => `Environment=${key}=${value}\n`)
  .join("")}Restart=always
RestartSec=5
StandardOutput=append:${logs.out}
StandardError=append:${logs.err}

[Install]
WantedBy=default.target
`,
    );
    if (!noStart) {
      bestEffort("systemctl", ["--user", "daemon-reload"]);
      const started = bestEffort("systemctl", [
        "--user",
        "enable",
        "--now",
        systemdUnitName(),
      ]);
      if (!started) reportNotRunning(command);
      console.log(`Installed systemd user service: ${unitPath}`);
      return started;
    }
    console.log(`Installed systemd user service: ${unitPath}`);
    return false;
  }

  throw new Error(
    "install-service currently supports macOS launchd and Linux systemd user services.",
  );
}

/** Whether this stack has a login service installed. */
export function serviceInstalled(): boolean {
  if (process.platform === "darwin") return existsSync(launchdPlistPath());
  if (process.platform === "linux") return existsSync(systemdUnitPath());
  return false;
}

/**
 * Stop the running daemon of this stack. Under Foundry Worker.app the daemon
 * is the app's child, so removing or restarting the launchd job alone would
 * leave it running; the daemon lock names its process.
 */
export async function stopDaemonProcess(): Promise<void> {
  const pid = daemonLockHolder();
  if (pid === undefined) return;
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 50 && alive(); i++)
    await new Promise((done) => setTimeout(done, 100));
  if (alive()) process.kill(pid, "SIGKILL");
}

/**
 * Rewrite and restart the installed service for a new runtime. On macOS the
 * launchd job is removed first, which stops Foundry Worker.app (so the app
 * can be rebuilt when its own content changed, without the old one reacting),
 * then the worker is stopped and the job installed again.
 */
/**
 * Without a systemd user session (containers, some servers) the worker is
 * not running; say so and how to run it.
 */
function reportNotRunning(command: string): void {
  console.error(
    `\nThe worker is not running: this machine has no systemd user session to start it.\nStart it in the foreground (or under your own supervisor) with:\n  ${command}\n`,
  );
}

/** Rewrites the service for a new runtime; says whether the worker restarted. */
export async function reinstallService(host: ServiceHost): Promise<boolean> {
  if (process.platform === "darwin") {
    if (typeof process.getuid === "function")
      spawnSync("launchctl", [
        "bootout",
        `gui/${process.getuid()}`,
        launchdPlistPath(),
      ]);
    await stopDaemonProcess();
    installService([], host);
    return true;
  }
  installService(["--no-start"], host);
  bestEffort("systemctl", ["--user", "daemon-reload"]);
  if (bestEffort("systemctl", ["--user", "restart", systemdUnitName()]))
    return true;
  const execStart = readFileSync(systemdUnitPath(), "utf8").match(
    /^ExecStart=(.*)$/m,
  )?.[1];
  if (!execStart) return false;
  const running = daemonLockHolder();
  if (running === undefined) reportNotRunning(execStart);
  else
    console.error(
      `\nThe worker running now (pid ${running}) still uses the previous version, and there is no systemd user session to restart it.\nStop it, then start it again with:\n  ${execStart}\n`,
    );
  return false;
}

export function uninstallService(): void {
  if (process.platform === "darwin") {
    const plistPath = launchdPlistPath();
    const watchdogPath = resolve(
      dirname(plistPath),
      `${watchdogLabel()}.plist`,
    );
    for (const path of [watchdogPath, plistPath]) {
      if (typeof process.getuid === "function") {
        bestEffort("launchctl", ["bootout", `gui/${process.getuid()}`, path]);
      }
      if (existsSync(path)) rmSync(path);
    }
    console.log(`Removed launchd service: ${plistPath}`);
    return;
  }

  if (process.platform === "linux") {
    const unitPath = systemdUnitPath();
    bestEffort("systemctl", ["--user", "disable", "--now", systemdUnitName()]);
    if (existsSync(unitPath)) {
      rmSync(unitPath);
    }
    bestEffort("systemctl", ["--user", "daemon-reload"]);
    console.log(`Removed systemd user service: ${unitPath}`);
    return;
  }

  throw new Error("uninstall-service currently supports macOS and Linux.");
}
export function status(): void {
  const config = readDaemonConfig();
  console.log(`Config: ${config ? daemonConfigPath : "not paired"}`);
  // Set when installed with `install`; a source checkout has no runtime.
  try {
    const version = readlinkSync(foundryStatePath("runtime", "current")).split(
      "+",
    )[0];
    console.log(`Installed version: ${version}`);
  } catch {
    // Not installed from npm.
  }
  if (existsSync(foundryStatePath("Foundry Worker.app")))
    console.log(`Hosted by: ${foundryStatePath("Foundry Worker.app")}`);
  if (config) {
    console.log(`Server: ${config.serverURL}`);
    console.log(`Workspace: ${config.workspacePath}`);
  }

  if (process.platform === "darwin") {
    const plistPath = launchdPlistPath();
    console.log(
      `Service: ${existsSync(plistPath) ? plistPath : "not installed"}`,
    );
    if (existsSync(plistPath) && typeof process.getuid === "function") {
      const result = spawnSync(
        "launchctl",
        ["print", `gui/${process.getuid()}/${serviceLabel()}`],
        {
          encoding: "utf8",
        },
      );
      console.log(`Launchd: ${result.status === 0 ? "loaded" : "not loaded"}`);
    }
    return;
  }

  if (process.platform === "linux") {
    const unitPath = systemdUnitPath();
    console.log(
      `Service: ${existsSync(unitPath) ? unitPath : "not installed"}`,
    );
    const result = spawnSync(
      "systemctl",
      ["--user", "is-active", systemdUnitName()],
      {
        encoding: "utf8",
      },
    );
    console.log(`Systemd: ${(result.stdout || "unknown").trim()}`);
    return;
  }

  console.log("Service: unsupported platform");
}
