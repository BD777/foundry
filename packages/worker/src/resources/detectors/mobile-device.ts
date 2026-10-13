// Physical phones and tablets attached to this device: Android ones through
// an adb server that is already running (asking adb otherwise starts its
// server, which detection must not do), Apple ones through `xcrun devicectl`
// (Xcode 15 and later).

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DetectedInstance, Detector } from "../detector.js";
import { macDeveloperToolsInstalled } from "./developer-tools.js";
import { androidSdkTool } from "./simulator.js";

/** Whether something listens on adb's local port (its server). */
function adbServerRunning(timeoutMs = 300): Promise<boolean> {
  return new Promise((resolveCheck) => {
    const socket = createConnection({ host: "127.0.0.1", port: 5037 });
    const done = (running: boolean) => {
      socket.destroy();
      resolveCheck(running);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export const androidDeviceDetector: Detector = {
  id: "mobile_device.android",
  version: 1,
  type: "mobile_device",
  platforms: ["darwin", "linux", "win32"],
  intervalMs: 2 * 60_000,
  timeoutMs: 4000,
  async detect(context) {
    const adb = androidSdkTool(context, "platform-tools", "adb");
    if (!adb || !(await adbServerRunning())) return [];
    const run = await context.exec(adb, ["devices", "-l"], {
      timeoutMs: 3000,
    });
    if (run.code !== 0)
      throw new Error(
        `adb devices failed: ${run.stderr.trim() || `exit ${run.code}`}`,
      );
    const instances: DetectedInstance[] = [];
    for (const line of run.stdout.split(/\r?\n/).slice(1)) {
      const [serial, state, ...rest] = line.trim().split(/\s+/);
      // Emulators are simulators (simulator.android), not devices.
      if (!serial || !state || serial.startsWith("emulator-")) continue;
      const properties = Object.fromEntries(
        rest
          .map((part) => part.split(":"))
          .filter((pair) => pair.length === 2) as [string, string][],
      );
      const ready = state === "device";
      instances.push({
        key: `mobile_device/android/${serial}`,
        type: "mobile_device",
        platform: "android",
        name: (properties.model ?? serial).replaceAll("_", " "),
        readiness: {
          ready,
          level: ready ? "permitted" : "installed",
          ...(ready
            ? {}
            : {
                reason:
                  state === "unauthorized"
                    ? "USB debugging is not authorized on the device."
                    : `adb reports it ${state}.`,
              }),
        },
        backends: [
          {
            id: "adb",
            mode: "listed",
            readiness: { ready, level: ready ? "permitted" : "installed" },
          },
        ],
        details: { serial, state, ...properties },
      });
    }
    return instances;
  },
};

interface DevicectlDevice {
  identifier?: string;
  deviceProperties?: { name?: string; osVersionNumber?: string };
  hardwareProperties?: {
    platform?: string;
    udid?: string;
    marketingName?: string;
    productType?: string;
  };
  connectionProperties?: {
    pairingState?: string;
    tunnelState?: string;
    transportType?: string;
  };
}

export const appleDeviceDetector: Detector = {
  id: "mobile_device.apple",
  version: 1,
  type: "mobile_device",
  platforms: ["darwin"],
  intervalMs: 2 * 60_000,
  timeoutMs: 8000,
  async detect(context) {
    if (!(await macDeveloperToolsInstalled(context))) return [];
    const found = await context.exec("/usr/bin/xcrun", ["-f", "devicectl"], {
      timeoutMs: 2000,
    });
    if (found.code !== 0) return [];
    const directory = mkdtempSync(join(tmpdir(), "fdy-devicectl-"));
    try {
      const output = join(directory, "devices.json");
      const run = await context.exec(
        "/usr/bin/xcrun",
        ["devicectl", "list", "devices", "--quiet", "--json-output", output],
        { timeoutMs: 7000 },
      );
      if (run.code !== 0)
        throw new Error(
          `devicectl failed: ${run.stderr.trim() || `exit ${run.code}`}`,
        );
      const listed = JSON.parse(readFileSync(output, "utf8")) as {
        result?: { devices?: DevicectlDevice[] };
      };
      return (listed.result?.devices ?? []).flatMap(
        (device): DetectedInstance[] => {
          const id = device.hardwareProperties?.udid ?? device.identifier;
          if (!id) return [];
          const connection = device.connectionProperties ?? {};
          const paired = connection.pairingState === "paired";
          const reachable =
            !!connection.tunnelState &&
            connection.tunnelState !== "unavailable";
          const ready = paired && reachable;
          const readiness = {
            ready,
            level: paired ? ("permitted" as const) : ("installed" as const),
            ...(ready
              ? {}
              : {
                  reason: paired
                    ? "Not connected now."
                    : "Not paired with this Mac.",
                }),
          };
          return [
            {
              key: `mobile_device/apple/${id}`,
              type: "mobile_device",
              platform:
                device.hardwareProperties?.platform === "iOS" ? "ios" : "any",
              name:
                device.deviceProperties?.name ??
                device.hardwareProperties?.marketingName ??
                id,
              readiness,
              backends: [{ id: "devicectl", mode: "listed", readiness }],
              details: Object.fromEntries(
                Object.entries({
                  model: device.hardwareProperties?.marketingName,
                  productType: device.hardwareProperties?.productType,
                  osVersion: device.deviceProperties?.osVersionNumber,
                  transport: connection.transportType,
                  pairing: connection.pairingState,
                  tunnel: connection.tunnelState,
                }).filter((entry): entry is [string, string] =>
                  Boolean(entry[1]),
                ),
              ),
            },
          ];
        },
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
};
