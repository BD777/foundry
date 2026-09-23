/**
 * Service installation — launchd (macOS) and systemd (Linux) setup.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DaemonConfig } from "./config.js";
import { daemonConfigPath, readDaemonConfig } from "./config.js";
import { optionEnabled } from "./utils.js";
import { foundryStackSuffix, foundryStatePath } from "./state-root.js";

export const daemonLogDir = foundryStatePath("logs");

export function serviceLabel(): string {
  return `dev.foundry${foundryStackSuffix()}.worker`;
}

export function serviceLogPaths(): { err: string; out: string } {
  return {
    err: resolve(daemonLogDir, "daemon.err.log"),
    out: resolve(daemonLogDir, "daemon.out.log"),
  };
}

export function serviceArgs(config: DaemonConfig): string[] {
  return [
    process.argv[1] ?? "foundry-worker",
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
  return resolve(
    homedir(),
    ".config",
    "systemd",
    "user",
    "foundry-worker.service",
  );
}

export function bestEffort(command: string, args: string[]): void {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    console.error(
      `Warning: ${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`,
    );
  }
}

export function installService(args: string[]): void {
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
    const argsXML = [process.execPath, ...serviceArgs(config)]
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
      bestEffort("launchctl", ["bootout", target, plistPath]);
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
      "dev.foundry.worker-watchdog.plist",
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
  <string>dev.foundry.worker-watchdog</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>${xmlEscape(watchdogScript)}</string>
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
      bestEffort("launchctl", ["bootout", target, watchdogPath]);
      bestEffort("launchctl", ["bootstrap", target, watchdogPath]);
      bestEffort("launchctl", [
        "enable",
        `${target}/dev.foundry.worker-watchdog`,
      ]);
    }
    console.log(`Installed watchdog: ${watchdogPath}`);
    return;
  }

  if (process.platform === "linux") {
    const unitPath = systemdUnitPath();
    mkdirSync(dirname(unitPath), { recursive: true });
    const command = [process.execPath, ...serviceArgs(config)]
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
Restart=always
RestartSec=5
StandardOutput=append:${logs.out}
StandardError=append:${logs.err}

[Install]
WantedBy=default.target
`,
    );
    if (!noStart) {
      bestEffort("systemctl", ["--user", "daemon-reload"]);
      bestEffort("systemctl", [
        "--user",
        "enable",
        "--now",
        "foundry-worker.service",
      ]);
    }
    console.log(`Installed systemd user service: ${unitPath}`);
    return;
  }

  throw new Error(
    "install-service currently supports macOS launchd and Linux systemd user services.",
  );
}

export function uninstallService(): void {
  if (process.platform === "darwin") {
    const plistPath = launchdPlistPath();
    if (typeof process.getuid === "function") {
      bestEffort("launchctl", [
        "bootout",
        `gui/${process.getuid()}`,
        plistPath,
      ]);
    }
    if (existsSync(plistPath)) {
      rmSync(plistPath);
    }
    console.log(`Removed launchd service: ${plistPath}`);
    return;
  }

  if (process.platform === "linux") {
    const unitPath = systemdUnitPath();
    bestEffort("systemctl", [
      "--user",
      "disable",
      "--now",
      "foundry-worker.service",
    ]);
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
      ["--user", "is-active", "foundry-worker.service"],
      {
        encoding: "utf8",
      },
    );
    console.log(`Systemd: ${(result.stdout || "unknown").trim()}`);
    return;
  }

  console.log("Service: unsupported platform");
}
