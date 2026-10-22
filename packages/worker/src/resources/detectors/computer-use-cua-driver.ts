// macOS screen control through cua-driver (remote_ops: any session holding
// a lease operates it through Foundry). The same instance as the worker's
// own screen control (computer-use-macos.ts): one desktop, two backends.
// Passive: it reads the binary, its version and, through a daemon already
// running, the grants of CuaDriver.app; it never starts the daemon and
// never prompts (Request access does, and its run is reported here).
// "verified" is never reported.

import type { ResourceReadiness } from "@bd777/foundry-protocol";
import { cuaDriverBackend } from "@bd777/foundry-protocol";
import {
  cuaDriverEnv,
  cuaDriverGrantRun,
  cuaDriverPermissionWatchActive,
  resolveCuaDriverBinary,
  type CuaDriverGrantRun,
} from "../cua-driver-host.js";
import type { DetectContext, DetectedInstance, Detector } from "../detector.js";

export interface CuaDriverGrants {
  accessibility: boolean;
  screenRecording: boolean;
}

export interface CuaDriverPermissions {
  /** A CuaDriver daemon answered (or is listening). */
  running: boolean;
  /** Its grants, when known. */
  grants?: CuaDriverGrants;
  /** status "unknown": cua-driver cannot read its real grants yet. */
  unknown?: boolean;
}

/**
 * `cua-driver permissions status --json`, as cua-driver 0.34 prints it
 * (run_permissions_status in libs/cua-driver/rust/crates/cua-driver/src/cli.rs,
 * github.com/trycua/cua at 7a1dcd0):
 * - no trustworthy answer: {"daemon_running": bool, "status": "unknown",
 *   "reason": "..."} with no grant booleans;
 * - verified by the daemon itself: its check_permissions result, with
 *   top-level booleans "accessibility" and "screen_recording" (plus
 *   "screen_recording_capturable", "direct_capture_verification" and
 *   "source": {"attribution": "driver-daemon"}).
 * Any other shape is read loosely for grant keys.
 */
export function parseCuaDriverPermissions(
  output: string,
): CuaDriverPermissions {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return { running: false };
  }
  if (!parsed || typeof parsed !== "object") return { running: false };
  const record = parsed as Record<string, unknown>;
  if (record.status === "unknown")
    return { running: record.daemon_running === true, unknown: true };
  if (
    typeof record.accessibility === "boolean" &&
    typeof record.screen_recording === "boolean"
  )
    return {
      running: true,
      grants: {
        accessibility: record.accessibility,
        screenRecording: record.screen_recording,
      },
    };
  return parseLoosely(record);
}

function parseLoosely(record: Record<string, unknown>): CuaDriverPermissions {
  const found: Partial<Record<keyof CuaDriverGrants, boolean>> = {};
  const granted = (value: unknown): boolean | undefined =>
    typeof value === "boolean"
      ? value
      : typeof value === "string"
        ? /^(granted|true|yes|authorized)$/i.test(value.trim())
        : undefined;
  const walk = (value: unknown, depth: number): void => {
    if (!value || typeof value !== "object" || depth > 3) return;
    for (const [key, entry] of Object.entries(value)) {
      if (
        /^accessibility(_granted)?$/i.test(key) &&
        found.accessibility === undefined
      )
        found.accessibility = granted(entry);
      else if (
        /^screen_?recording(_granted)?$/i.test(key) &&
        found.screenRecording === undefined
      )
        found.screenRecording = granted(entry);
      else walk(entry, depth + 1);
    }
  };
  walk(record, 0);
  if (found.accessibility === undefined && found.screenRecording === undefined)
    return { running: record.daemon_running === true };
  return {
    running: record.daemon_running !== false,
    grants: {
      accessibility: found.accessibility === true,
      screenRecording: found.screenRecording === true,
    },
  };
}

export function createCuaDriverDetector(
  options: {
    resolveBinary?: (env: NodeJS.ProcessEnv) => string | undefined;
    uid?: () => number;
    /** The last Request access (cua-driver permissions grant) run. */
    grantRun?: () => CuaDriverGrantRun | undefined;
    /** Whether the grants are being watched live (watchCuaDriverPermissions). */
    watching?: () => boolean;
  } = {},
): Detector {
  const grantRun = options.grantRun ?? cuaDriverGrantRun;
  const watching = options.watching ?? cuaDriverPermissionWatchActive;
  const resolveBinary =
    options.resolveBinary ?? ((env) => resolveCuaDriverBinary(env, "darwin"));
  const uid = options.uid ?? (() => process.getuid?.() ?? 0);
  return {
    id: "computer_use.macos.cua-driver",
    version: 1,
    type: "computer_use",
    platforms: ["darwin"],
    intervalMs: 2 * 60_000,
    timeoutMs: 6000,
    async detect(context: DetectContext) {
      const env = cuaDriverEnv(context.env);
      const binary = resolveBinary(env);
      const details: Record<string, string> = {
        grantTo: "CuaDriver.app",
        windowScope: "v1",
      };
      let readiness: ResourceReadiness;
      let version: string | undefined;
      if (!binary) {
        readiness = {
          ready: false,
          level: "installed",
          reason: "cua-driver is not installed on this Mac.",
          missing: ["cua_driver_not_installed"],
        };
      } else {
        details.path = binary;
        const versionRun = await context.exec(binary, ["--version"], {
          env,
          timeoutMs: 2000,
          maxOutputBytes: 4096,
        });
        version = /\d+\.\d+\.\d+[\w.+-]*/.exec(versionRun.stdout)?.[0];
        if (version) details.version = version;
        const run = grantRun();
        readiness = await readGrants(context, binary, env, run);
        // Once both grants are confirmed, an earlier run that gave up is moot.
        const runDetails = grantRunDetails(run);
        if (
          !readiness.ready ||
          runDetails.grantRun === "waiting" ||
          runDetails.grantRun === "verified"
        )
          Object.assign(details, runDetails);
        if (watching() && !readiness.ready) details.permissionCheck = "live";
      }
      const instance: DetectedInstance = {
        key: `computer_use/macos/console:${uid()}`,
        type: "computer_use",
        platform: "macos",
        name: "macOS screen control",
        readiness,
        backends: [
          {
            id: cuaDriverBackend,
            mode: "remote_ops",
            ...(version ? { version } : {}),
            readiness,
          },
        ],
        details,
      };
      return [instance];
    },
  };
}

const waitingForApproval =
  "Waiting for you on the Mac: approve CuaDriver's Accessibility, Screen Recording and screen-capture prompts.";

/**
 * The last grant run for the page, as details: grantRun "waiting" |
 * "verified" | "failed" | "timed_out" and grantOutput, cua-driver's last
 * lines when it did not verify.
 */
export const cuaDriverGrantDetailKeys = [
  "grantRun",
  "grantOutput",
  "permissionCheck",
] as const;

function grantRunDetails(
  run: CuaDriverGrantRun | undefined,
): Record<string, string> {
  if (!run) return {};
  if (run.state === "running") return { grantRun: "waiting" };
  if (run.state === "finished" && run.code === 0)
    return { grantRun: "verified" };
  const outcome = run.state === "timed_out" ? "timed_out" : "failed";
  const exit =
    run.state === "finished" && run.code !== null ? `exit ${run.code}` : "";
  const output = run.output || exit;
  return { grantRun: outcome, ...(output ? { grantOutput: output } : {}) };
}

async function readGrants(
  context: DetectContext,
  binary: string,
  env: NodeJS.ProcessEnv,
  grantRun: CuaDriverGrantRun | undefined,
): Promise<ResourceReadiness> {
  const run = await context.exec(binary, ["permissions", "status", "--json"], {
    env,
    timeoutMs: 3000,
    maxOutputBytes: 64 * 1024,
  });
  const status: CuaDriverPermissions =
    run.code === 0 ? parseCuaDriverPermissions(run.stdout) : { running: false };
  const waiting = grantRun?.state === "running";
  const failed = grantRunDetails(grantRun).grantRun;
  const withProblem = (reason: string) =>
    failed === "failed" || failed === "timed_out"
      ? `The last permission check did not verify. ${reason}`
      : reason;
  if (waiting && !status.grants)
    return {
      ready: false,
      level: status.running ? "configured" : "installed",
      reason: waitingForApproval,
      missing: [
        "cua_driver_awaiting_approval",
        "tcc_accessibility",
        "tcc_screen_recording",
      ],
    };
  if (!status.running)
    return {
      ready: false,
      level: "installed",
      reason: withProblem(
        run.timedOut
          ? "CuaDriver did not answer in time. Request access starts it and asks for its permissions."
          : "CuaDriver is not running on this Mac. Request access starts it and asks for its permissions.",
      ),
      missing: ["cua_driver_not_running"],
    };
  // A daemon that answers "unknown" is still in its own permission check,
  // or that check gave up (after 10 minutes, see cuaDriverGateWindowMs in cua-driver-host.ts) and it
  // stays stuck until restarted; `cua-driver diagnose` then says "daemon
  // unavailable". Its grants are not known either way.
  if (!status.grants)
    return {
      ready: false,
      level: "configured",
      reason: withProblem(
        "CuaDriver is running but has not confirmed its macOS permissions. It stops checking 10 minutes after it starts, so permissions turned on later count only after a restart: Request access restarts it and asks again.",
      ),
      missing: ["tcc_accessibility", "tcc_screen_recording"],
    };
  const grants = status.grants;
  const missing = [
    grants.accessibility ? "" : "tcc_accessibility",
    grants.screenRecording ? "" : "tcc_screen_recording",
  ].filter(Boolean);
  if (!missing.length) return { ready: true, level: "permitted" };
  const names = [
    grants.accessibility ? "" : "Accessibility",
    grants.screenRecording ? "" : "Screen Recording",
  ].filter(Boolean);
  return {
    ready: false,
    level: "configured",
    reason: waiting
      ? waitingForApproval
      : withProblem(
          `${names.join(" and ")} not granted to CuaDriver.app (System Settings → Privacy & Security). Request access asks for them.`,
        ),
    missing: waiting ? ["cua_driver_awaiting_approval", ...missing] : missing,
  };
}

export const cuaDriverScreenControlDetector = createCuaDriverDetector();
