/**
 * On macOS the worker's login service is hosted by a small local app,
 * "Foundry Worker.app", so that macOS privacy grants (Screen Recording,
 * Accessibility) name Foundry instead of the Node.js binary, which every Node
 * program on the machine shares. The app is built with tools every Mac has
 * (osacompile, PlistBuddy, codesign): no Xcode, nothing downloaded.
 *
 * The app only runs a launcher script at a fixed path, so updating the worker
 * rewrites the script but never the app. macOS keys a grant to the app's code
 * signature, so grants survive worker updates.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { foundryStackSuffix, foundryStatePath } from "./state-root.js";

/** Bump when the app's own content changes; it forces a rebuild. */
const appRevision = "1";

export function workerAppName(): string {
  const stack = foundryStackSuffix().slice(1);
  return stack ? `Foundry Worker (${stack})` : "Foundry Worker";
}

export function workerAppPath(): string {
  return foundryStatePath("Foundry Worker.app");
}

export function workerLauncherPath(): string {
  return foundryStatePath("worker.sh");
}

export function workerAppExecutable(): string {
  return join(workerAppPath(), "Contents", "MacOS", "applet");
}

function bundleIdentifier(): string {
  const stack = foundryStackSuffix()
    .slice(1)
    .replace(/[^A-Za-z0-9-]/g, "-");
  return stack ? `app.foundry.worker.${stack}` : "app.foundry.worker";
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * The script the app runs: the service environment, the log redirection and
 * the worker command. Rewritten on every install and update.
 */
export function workerLauncherScript(input: {
  command: string[];
  env: Record<string, string>;
  logs: { out: string; err: string };
}): string {
  return [
    "#!/bin/sh",
    "# Written by foundry-worker install/update; run by Foundry Worker.app.",
    ...Object.entries(input.env).map(
      ([key, value]) => `export ${key}=${shellQuote(value)}`,
    ),
    `export FOUNDRY_WORKER_APP=${shellQuote(workerAppName())}`,
    `exec >>${shellQuote(input.logs.out)} 2>>${shellQuote(input.logs.err)}`,
    `exec ${input.command.map(shellQuote).join(" ")}`,
    "",
  ].join("\n");
}

/**
 * The AppleScript the app runs; stable, so the app's signature is too. When
 * the worker stops (a restart, the watchdog, an update) `do shell script`
 * raises an error; it is swallowed so the app quits quietly and launchd's
 * KeepAlive starts it again, instead of the app showing an error dialog.
 */
function appScript(): string[] {
  const launcher = workerLauncherPath().replaceAll('"', '\\"');
  return [
    "try",
    `  do shell script "exec /bin/sh " & quoted form of "${launcher}"`,
    "end try",
  ];
}

function fingerprint(): string {
  return createHash("sha256")
    .update(`${appRevision}\n${bundleIdentifier()}\n${appScript().join("\n")}`)
    .digest("hex");
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(
      `${command} ${args[0] ?? ""} failed: ${(result.stderr || result.stdout || "").trim()}`,
    );
}

/**
 * Write the launcher script and make sure the app exists. The app is only
 * rebuilt when its own content would change, never on a worker update.
 * Returns the app's executable, or undefined when this Mac lacks the system
 * tools (the service then runs Node directly).
 */
export function ensureWorkerApp(launcherScript: string): string | undefined {
  writeFileSync(workerLauncherPath(), launcherScript, { mode: 0o700 });
  if (!["/usr/bin/osacompile", "/usr/bin/codesign"].every(existsSync))
    return undefined;
  const app = workerAppPath();
  const marker = join(app, "Contents", "Resources", "foundry-worker-app");
  const wanted = fingerprint();
  if (existsSync(marker) && readFileSync(marker, "utf8") === wanted)
    return workerAppExecutable();
  rmSync(app, { recursive: true, force: true });
  run("/usr/bin/osacompile", [
    "-o",
    app,
    ...appScript().flatMap((line) => ["-e", line]),
  ]);
  const plist = join(app, "Contents", "Info.plist");
  const setOrAdd = (key: string, type: string, value: string) => {
    const set = spawnSync("/usr/libexec/PlistBuddy", [
      "-c",
      `Set :${key} ${value}`,
      plist,
    ]);
    if (set.status !== 0)
      run("/usr/libexec/PlistBuddy", [
        "-c",
        `Add :${key} ${type} ${value}`,
        plist,
      ]);
  };
  setOrAdd("CFBundleIdentifier", "string", bundleIdentifier());
  setOrAdd("CFBundleName", "string", workerAppName());
  setOrAdd("CFBundleDisplayName", "string", workerAppName());
  // A background agent: no Dock icon, no menu bar.
  setOrAdd("LSUIElement", "bool", "true");
  writeFileSync(marker, wanted);
  run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", app]);
  return workerAppExecutable();
}

export function removeWorkerApp(): void {
  rmSync(workerAppPath(), { recursive: true, force: true });
  rmSync(workerLauncherPath(), { force: true });
}
