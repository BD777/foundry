// macOS screen control as the Foundry worker itself holds it: Screen
// Recording and Accessibility granted to the program that hosts the worker,
// used with screencapture and osascript. Moved from resource-pool.ts; what
// sessions are told is unchanged (discoverComputerUse). It is retired once
// a dedicated computer-use backend works.

import { execFileSync } from "node:child_process";
import type { DeviceResource } from "@bd777/foundry-protocol";
import type { DetectedInstance, Detector } from "../detector.js";

const macControlGrantsScript = [
  'ObjC.import("CoreGraphics");',
  'ObjC.import("ApplicationServices");',
  'ObjC.bindFunction("CGPreflightScreenCaptureAccess", ["bool", []]);',
  'ObjC.bindFunction("AXIsProcessTrusted", ["bool", []]);',
  "JSON.stringify({screenRecording: $.CGPreflightScreenCaptureAccess(), accessibility: $.AXIsProcessTrusted()})",
].join(" ");

export interface MacControlGrants {
  screenRecording: boolean;
  accessibility: boolean;
}

/**
 * The macOS privacy grants screen control needs, as held by this worker's
 * own process context. Queried without prompting and without touching the
 * screen; being a Mac is never taken as proof of access.
 */
export function macControlGrants(): MacControlGrants {
  const output = execFileSync(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", macControlGrantsScript],
    { encoding: "utf8", timeout: 5000 },
  );
  return JSON.parse(output) as MacControlGrants;
}

/** Screen control (computer use) on macOS, with its real grant state. */
export function discoverComputerUse(
  platform: NodeJS.Platform = process.platform,
  grants: () => MacControlGrants = macControlGrants,
): DeviceResource[] {
  if (platform !== "darwin") return [];
  const resource: DeviceResource = {
    id: "computer_use:macos",
    kind: "computer_use",
    name: "macOS screen control",
    available: false,
  };
  try {
    const granted = grants();
    const missing = [
      granted.screenRecording ? "" : "Screen Recording",
      granted.accessibility ? "" : "Accessibility",
    ].filter(Boolean);
    resource.available = missing.length === 0;
    resource.attributes = {
      screenRecording: granted.screenRecording ? "granted" : "not granted",
      accessibility: granted.accessibility ? "granted" : "not granted",
      // macOS grants these to the program that hosts the worker: Foundry
      // Worker.app when installed with `install`, else the Node binary.
      grantTo: process.env.FOUNDRY_WORKER_APP?.trim() || process.execPath,
    };
    if (missing.length)
      resource.detail = `${missing.join(" and ")} not granted to the Foundry worker (System Settings → Privacy & Security).`;
  } catch (error) {
    resource.detail = `Could not read the macOS privacy grants: ${error instanceof Error ? error.message : String(error)}`;
  }
  return [resource];
}

const macPrivacyPanes = {
  screenRecording: {
    name: "Screen Recording",
    url: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  },
  accessibility: {
    name: "Accessibility",
    url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  },
} as const;

/**
 * Ask the person at this device for access to a resource: macOS shows its
 * own permission prompts (which also list the worker in System Settings) and
 * the settings panes for grants still missing are opened. Returns the names
 * of the panes opened. Nothing is granted by Foundry itself.
 */
export function requestResourceAccess(
  resourceId: string,
  grants: () => MacControlGrants = macControlGrants,
  open: (url: string) => void = (url) =>
    execFileSync("/usr/bin/open", [url], { timeout: 10000 }),
  prompt: () => void = promptMacControlGrants,
): string[] {
  if (resourceId !== "computer_use:macos" || process.platform !== "darwin")
    throw new Error(`${resourceId} needs no access on this device`);
  prompt();
  const granted = grants();
  const opened: string[] = [];
  for (const key of ["screenRecording", "accessibility"] as const) {
    if (granted[key]) continue;
    open(macPrivacyPanes[key].url);
    opened.push(macPrivacyPanes[key].name);
  }
  return opened;
}

/** The system's own prompts for Screen Recording and Accessibility. */
function promptMacControlGrants(): void {
  const script = [
    'ObjC.import("CoreGraphics");',
    'ObjC.import("ApplicationServices");',
    'ObjC.bindFunction("CGRequestScreenCaptureAccess", ["bool", []]);',
    'ObjC.bindFunction("AXIsProcessTrustedWithOptions", ["bool", ["id"]]);',
    "$.CGRequestScreenCaptureAccess();",
    "$.AXIsProcessTrustedWithOptions($({AXTrustedCheckOptionPrompt: true}));",
  ].join(" ");
  execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], {
    timeout: 10000,
  });
}

/**
 * The worker's own screen control as an instance: the console desktop of
 * this user, driven by the worker (a native_session backend: only sessions
 * on this Mac use it). The grants are read without prompting.
 */
export const macWorkerScreenControlDetector: Detector = {
  id: "computer_use.macos.foundry-worker",
  version: 1,
  type: "computer_use",
  platforms: ["darwin"],
  intervalMs: 2 * 60_000,
  timeoutMs: 6000,
  async detect({ exec }) {
    const run = await exec(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", macControlGrantsScript],
      { timeoutMs: 5000 },
    );
    if (run.code !== 0)
      throw new Error(
        `could not read the macOS privacy grants: ${run.stderr.trim() || `exit ${run.code}`}`,
      );
    const [resource] = discoverComputerUse(
      "darwin",
      () => JSON.parse(run.stdout) as MacControlGrants,
    );
    const missing = [
      resource!.attributes?.screenRecording === "granted"
        ? ""
        : "tcc_screen_recording",
      resource!.attributes?.accessibility === "granted"
        ? ""
        : "tcc_accessibility",
    ].filter(Boolean);
    // This backend is only for sessions running on this Mac; Foundry
    // operates the screen remotely through cua-driver, granted separately.
    const reason = resource!.detail?.includes(
      "not granted to the Foundry worker",
    )
      ? `Only for sessions running on this Mac: ${resource!.detail}`
      : resource!.detail;
    const readiness = {
      ready: resource!.available,
      level: resource!.available
        ? ("permitted" as const)
        : ("installed" as const),
      ...(reason ? { reason } : {}),
      ...(missing.length ? { missing } : {}),
    };
    const instance: DetectedInstance = {
      key: `computer_use/macos/console:${process.getuid?.() ?? 0}`,
      type: "computer_use",
      platform: "macos",
      name: "macOS screen control",
      readiness,
      backends: [{ id: "foundry-worker", mode: "native_session", readiness }],
      details: resource!.attributes,
    };
    return [instance];
  },
};
