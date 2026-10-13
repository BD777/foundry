// cua-driver (github.com/trycua/cua, MIT) on this Mac: where its binary is,
// the environment every run of it gets (telemetry off), and asking the
// person for its macOS grants. The grants belong to CuaDriver.app, not to
// the Foundry worker.

import { homedir } from "node:os";
import { join } from "node:path";
import {
  execBounded,
  findOnPath,
  isExecutableFile,
  type ExecResult,
} from "./exec.js";
import { errorMessage } from "../utils.js";

export const cuaDriverAppPath = "/Applications/CuaDriver.app";
export const cuaDriverInstallerUrl = "https://cua.ai/driver/install.sh";

/** The cua-driver binary: the installer's symlink, the app's, then PATH. */
export function resolveCuaDriverBinary(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const home = env.HOME || homedir();
  for (const candidate of [
    join(home, ".local", "bin", "cua-driver"),
    `${cuaDriverAppPath}/Contents/MacOS/cua-driver`,
  ])
    if (isExecutableFile(candidate, platform)) return candidate;
  return findOnPath("cua-driver", env, platform);
}

/**
 * The environment for every cua-driver run: no telemetry (DO_NOT_TRACK
 * overrides all of it) and no edits to shell rc files by its installer.
 */
export function cuaDriverEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...env,
    DO_NOT_TRACK: "1",
    CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
    CUA_DRIVER_NO_MODIFY_PATH: "1",
  };
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxOutputBytes?: number;
  },
) => Promise<ExecResult>;

export const runBounded: CommandRunner = (command, args, options) =>
  execBounded(command, args, options);

/** The last `cua-driver permissions grant` this worker ran. */
export type CuaDriverGrantRun =
  | { state: "running"; startedAt: number }
  | {
      state: "finished";
      startedAt: number;
      code: number | null;
      /** The last lines it printed. */
      output: string;
    }
  | { state: "timed_out"; startedAt: number; output: string };

let lastGrantRun: CuaDriverGrantRun | undefined;

/** What the last grant run is doing or did; the detector reports it. */
export function cuaDriverGrantRun(): CuaDriverGrantRun | undefined {
  return lastGrantRun;
}

const grantTimeoutMs = 200_000;

function lastLines(result: ExecResult, count = 6): string {
  return `${result.stdout}\n${result.stderr}`
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .slice(-count)
    .join("\n");
}

function finishedRun(startedAt: number, result: ExecResult): CuaDriverGrantRun {
  return result.timedOut
    ? { state: "timed_out", startedAt, output: lastLines(result) }
    : {
        state: "finished",
        startedAt,
        code: result.code,
        output: lastLines(result),
      };
}

/**
 * cua-driver's permission check on `serve` (its "permissions gate") waits
 * this long for the grants (GateOpts deadline, 10 minutes, in
 * libs/cua-driver/rust/crates/platform-macos/src/permissions/gate.rs,
 * github.com/trycua/cua). When it gives up, the daemon keeps running but
 * answers every request, its permission status included, with
 * "permissions_pending" until it is restarted (cua-driver/src/main.rs:
 * "grant ... then restart the daemon"): grants given later never count.
 */
const cuaDriverGateWindowMs = 10 * 60_000;

/** When this worker last started CuaDriver's daemon. */
let daemonStartedAt: number | undefined;

/** Starts CuaDriver's daemon in the background (`open -a CuaDriver`). */
async function startCuaDriverDaemon(
  run: CommandRunner,
  env: NodeJS.ProcessEnv,
  now: () => number,
): Promise<void> {
  const started = await run(
    "/usr/bin/open",
    ["-n", "-g", "-a", "CuaDriver", "--args", "serve"],
    { env, timeoutMs: 10_000 },
  );
  if (started.code !== 0)
    throw new Error(
      `could not start CuaDriver: ${started.stderr.trim() || `exit ${started.code}`}`,
    );
  daemonStartedAt = now();
}

/** Stops CuaDriver's daemon (`cua-driver stop`, which waits for it). */
async function stopCuaDriverDaemon(
  binary: string,
  run: CommandRunner,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const stopped = await run(binary, ["stop"], { env, timeoutMs: 10_000 });
  if (stopped.code !== 0 && !/not running/i.test(stopped.stderr))
    throw new Error(
      `could not restart CuaDriver: ${stopped.stderr.trim() || `exit ${stopped.code}`}`,
    );
}

async function readPermissionStatus(host: Host): Promise<string> {
  const status = await host
    .run(host.binary, ["permissions", "status", "--json"], {
      env: host.env,
      timeoutMs: 3000,
      maxOutputBytes: 64 * 1024,
    })
    .catch(() => undefined);
  return status?.code === 0 ? status.stdout.trim() : "";
}

/**
 * Leaves CuaDriver's daemon with a live permission check before a grant
 * runs: starts it when none answers; restarts one that has not confirmed
 * its grants - always ("unconfirmed": the person asked again), or only
 * when this worker did not start it within the gate window ("stale": its
 * check may have given up). A fresh daemon asks macOS again and sees
 * grants given since. One with both grants confirmed is left alone.
 */
async function prepareCuaDriverDaemon(
  host: Host,
  status: string,
  restart: "unconfirmed" | "stale",
): Promise<void> {
  if (bothGranted(status)) return;
  if (status && !daemonDown(status)) {
    const fresh =
      daemonStartedAt !== undefined &&
      host.now() - daemonStartedAt < cuaDriverGateWindowMs;
    if (restart === "stale" && fresh) return;
    await stopCuaDriverDaemon(host.binary, host.run, host.env);
  }
  await startCuaDriverDaemon(host.run, host.env, host.now);
}

/**
 * Runs `cua-driver permissions grant` in the background, tracked as
 * lastGrantRun; only one at a time. It raises macOS's prompts for what is
 * missing and waits for them; when everything is already granted it only
 * verifies (the one way cua-driver's status stops being "unknown").
 */
function startGrant(
  binary: string,
  env: NodeJS.ProcessEnv,
  run: CommandRunner,
  now: () => number,
  onDone?: () => void,
): void {
  if (lastGrantRun?.state === "running") return;
  const startedAt = now();
  const current: CuaDriverGrantRun = { state: "running", startedAt };
  lastGrantRun = current;
  void run(binary, ["permissions", "grant"], {
    env,
    timeoutMs: grantTimeoutMs,
  })
    .then(
      (result) => finishedRun(startedAt, result),
      (error: unknown): CuaDriverGrantRun => ({
        state: "finished",
        startedAt,
        code: null,
        output: errorMessage(error),
      }),
    )
    .then((outcome) => {
      if (lastGrantRun === current) lastGrantRun = outcome;
    })
    .finally(() => onDone?.());
}

interface HostOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  run?: CommandRunner;
  binary?: string;
  now?: () => number;
}

interface Host {
  env: NodeJS.ProcessEnv;
  binary: string;
  run: CommandRunner;
  now: () => number;
}

function hostFor(options: HostOptions): Host {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") throw new Error("cua-driver runs on macOS only");
  const env = cuaDriverEnv(options.env ?? process.env);
  const binary = options.binary ?? resolveCuaDriverBinary(env, platform);
  if (!binary)
    throw new Error(
      "cua-driver is not installed on this Mac; install it first",
    );
  return {
    env,
    binary,
    run: options.run ?? runBounded,
    now: options.now ?? Date.now,
  };
}

/**
 * Asks the person at this Mac for CuaDriver's grants: (re)starts its
 * daemon unless it already confirmed both grants (a daemon whose check
 * gave up, or that predates a grant, never reports it), then runs
 * `cua-driver permissions grant`, which raises macOS's prompts naming
 * CuaDriver, waits (up to about 3 minutes) for them and verifies screen
 * capture. The wait runs in the background and is tracked
 * (cuaDriverGrantRun); onDone follows it (a rescan). A grant already
 * waiting is not started again. With onChange, the grants are then
 * watched live (watchCuaDriverPermissions). Returns what was opened.
 */
export async function requestCuaDriverAccess(
  options: HostOptions & {
    onDone?: () => void;
    onChange?: () => void;
  } = {},
): Promise<string[]> {
  const host = hostFor(options);
  if (lastGrantRun?.state !== "running") {
    await prepareCuaDriverDaemon(
      host,
      await readPermissionStatus(host),
      "unconfirmed",
    );
    startGrant(host.binary, host.env, host.run, host.now, options.onDone);
  }
  if (options.onChange)
    watchCuaDriverPermissions({ ...options, onChange: options.onChange });
  return ["cua-driver"];
}

/** The System Settings panes CuaDriver's grants live in. */
export const cuaDriverSettingsPanes = {
  accessibility: {
    name: "Accessibility",
    // Privacy & Security → Accessibility; the legacy anchor System
    // Settings still routes (macOS 13 and later, incl. 15 and 26).
    url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  },
  "screen-recording": {
    // Named "Screen & System Audio Recording" from macOS 15 on.
    name: "Screen Recording",
    url: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  },
} as const;

export type CuaDriverSettingsPane = keyof typeof cuaDriverSettingsPanes;

export function isCuaDriverSettingsPane(
  value: string,
): value is CuaDriverSettingsPane {
  return Object.hasOwn(cuaDriverSettingsPanes, value);
}

/**
 * Opens one System Settings pane on this Mac for the person to turn
 * CuaDriver on there, then watches the grants live (onChange on each
 * change). Returns the pane's name.
 */
export async function openCuaDriverSettings(
  pane: CuaDriverSettingsPane,
  options: HostOptions & { onChange?: () => void } = {},
): Promise<string[]> {
  const host = hostFor(options);
  const target = cuaDriverSettingsPanes[pane];
  const opened = await host.run("/usr/bin/open", [target.url], {
    env: host.env,
    timeoutMs: 10_000,
  });
  if (opened.code !== 0)
    throw new Error(
      `could not open System Settings: ${opened.stderr.trim() || `exit ${opened.code}`}`,
    );
  if (options.onChange)
    watchCuaDriverPermissions({ ...options, onChange: options.onChange });
  return [target.name];
}

const watchIntervalMs = 3000;
const watchDurationMs = 3 * 60_000;
/** The least time between two grants the watch starts itself. */
const regrantGapMs = 15_000;

interface PermissionWatch {
  until: number;
  lastStatus?: string;
  lastGrantAt: number;
  /** A grant was run to verify grants confirmed after one that did not. */
  verifying?: boolean;
  timer?: NodeJS.Timeout;
}

let permissionWatch: PermissionWatch | undefined;

/** Whether the grants are being watched live now. */
export function cuaDriverPermissionWatchActive(): boolean {
  return permissionWatch !== undefined;
}

function bothGranted(output: string): boolean {
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    return parsed.accessibility === true && parsed.screen_recording === true;
  } catch {
    return false;
  }
}

function statusUnknown(output: string): boolean {
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    return parsed.status === "unknown";
  } catch {
    return true;
  }
}

function daemonDown(output: string): boolean {
  try {
    return (
      (JSON.parse(output) as Record<string, unknown>).daemon_running === false
    );
  } catch {
    return false;
  }
}

function grantUnverified(run: CuaDriverGrantRun | undefined): boolean {
  return (
    run !== undefined &&
    run.state !== "running" &&
    !(run.state === "finished" && run.code === 0)
  );
}

/**
 * Re-reads `cua-driver permissions status --json` every 3 s for 3 minutes
 * (extended by each new call) and calls onChange as soon as it changes or
 * a grant run ends; stops once both grants are confirmed (after one grant
 * run that verifies them, when the last run did not). cua-driver reports
 * "unknown" while no daemon answers or its permission check is still
 * pending, so then, with no grant running, the watch runs one (at most
 * every 15 s), first restarting a daemon whose check may have given up.
 */
export function watchCuaDriverPermissions(
  options: HostOptions & {
    onChange: () => void;
    intervalMs?: number;
    durationMs?: number;
  },
): void {
  const host = hostFor(options);
  const interval = options.intervalMs ?? watchIntervalMs;
  const until = host.now() + (options.durationMs ?? watchDurationMs);
  if (permissionWatch) {
    permissionWatch.until = Math.max(permissionWatch.until, until);
    return;
  }
  const watch: PermissionWatch = { until, lastGrantAt: 0 };
  permissionWatch = watch;
  const stop = () => {
    if (watch.timer) clearTimeout(watch.timer);
    if (permissionWatch === watch) permissionWatch = undefined;
    options.onChange();
  };
  const tick = async () => {
    if (permissionWatch !== watch) return;
    if (host.now() > watch.until) return stop();
    const output = await readPermissionStatus(host);
    if (permissionWatch !== watch) return;
    const changed = output !== watch.lastStatus;
    watch.lastStatus = output;
    if (bothGranted(output)) {
      // Granted after a run gave up (in System Settings, say): one more run
      // verifies it, so the page says so instead of the old failure.
      if (!watch.verifying && grantUnverified(lastGrantRun)) {
        watch.verifying = true;
        startGrant(host.binary, host.env, host.run, host.now, options.onChange);
      }
      return stop();
    }
    if (
      lastGrantRun?.state !== "running" &&
      statusUnknown(output) &&
      host.now() - watch.lastGrantAt >= regrantGapMs
    ) {
      watch.lastGrantAt = host.now();
      try {
        await prepareCuaDriverDaemon(host, output, "stale");
        startGrant(host.binary, host.env, host.run, host.now, options.onChange);
        options.onChange();
      } catch (error) {
        console.warn(`cua-driver permission recheck: ${errorMessage(error)}`);
      }
    } else if (changed) options.onChange();
    watch.timer = setTimeout(() => void tick(), interval);
    watch.timer.unref?.();
  };
  // The page shows the watch at once.
  options.onChange();
  watch.timer = setTimeout(() => void tick(), 0);
  watch.timer.unref?.();
}

/** Stops watching the grants (tests, shutdown). */
export function stopCuaDriverPermissionWatch(): void {
  if (permissionWatch?.timer) clearTimeout(permissionWatch.timer);
  permissionWatch = undefined;
}

/** Forgets the last grant run and daemon start (tests). */
export function resetCuaDriverGrantRun(): void {
  lastGrantRun = undefined;
  daemonStartedAt = undefined;
}
