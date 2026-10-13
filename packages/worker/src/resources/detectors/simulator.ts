// Simulators and emulators: iOS-family simulators from `xcrun simctl`
// (macOS with Xcode) and Android virtual devices from `emulator
// -list-avds` (wherever the Android SDK is). Listing them boots nothing.

import { join } from "node:path";
import type { ResourcePlatform } from "@bd777/foundry-protocol";
import type { DetectContext, DetectedInstance, Detector } from "../detector.js";
import { findOnPath, isExecutableFile } from "../exec.js";
import { macDeveloperToolsInstalled } from "./developer-tools.js";

interface SimctlDevice {
  udid?: string;
  name?: string;
  state?: string;
  isAvailable?: boolean;
  deviceTypeIdentifier?: string;
}

/** "com.apple.CoreSimulator.SimRuntime.iOS-17-5" → ["iOS 17.5", "ios"]. */
function simulatorRuntime(identifier: string): [string, ResourcePlatform] {
  const match = /SimRuntime\.([A-Za-z]+)-([\d-]+)$/.exec(identifier);
  if (!match) return [identifier, "any"];
  const [, os, version] = match;
  return [
    `${os} ${version!.replaceAll("-", ".")}`,
    os === "iOS" ? "ios" : "any",
  ];
}

export const iosSimulatorDetector: Detector = {
  id: "simulator.ios",
  version: 1,
  type: "simulator",
  platforms: ["darwin"],
  intervalMs: 5 * 60_000,
  timeoutMs: 8000,
  async detect(context) {
    if (!(await macDeveloperToolsInstalled(context))) return [];
    const run = await context.exec(
      "/usr/bin/xcrun",
      ["simctl", "list", "devices", "available", "-j"],
      { timeoutMs: 7000 },
    );
    // Command line tools without Xcode have no simctl: no simulators.
    if (run.code !== 0 && /unable to find utility/i.test(run.stderr)) return [];
    if (run.code !== 0)
      throw new Error(
        `simctl failed: ${run.stderr.trim() || `exit ${run.code}`}`,
      );
    const listed = JSON.parse(run.stdout) as {
      devices?: Record<string, SimctlDevice[]>;
    };
    const instances: DetectedInstance[] = [];
    for (const [runtime, devices] of Object.entries(listed.devices ?? {})) {
      const [runtimeLabel, platform] = simulatorRuntime(runtime);
      for (const device of devices) {
        if (!device.udid || device.isAvailable === false) continue;
        instances.push({
          key: `simulator/ios/${device.udid}`,
          type: "simulator",
          platform,
          name: `${device.name ?? device.udid} (${runtimeLabel})`,
          readiness: { ready: true, level: "installed" },
          backends: [
            {
              id: "simctl",
              mode: "listed",
              readiness: { ready: true, level: "installed" },
            },
          ],
          details: {
            udid: device.udid,
            runtime: runtimeLabel,
            state: device.state ?? "unknown",
          },
        });
      }
    }
    return instances;
  },
};

/** The Android SDK's program at relative, or on PATH. */
export function androidSdkTool(
  context: Pick<DetectContext, "env" | "platform">,
  relative: string,
  name: string,
): string | undefined {
  const exe = context.platform === "win32" ? ".exe" : "";
  for (const root of [context.env.ANDROID_HOME, context.env.ANDROID_SDK_ROOT]) {
    if (!root) continue;
    const candidate = join(root, relative, name + exe);
    if (isExecutableFile(candidate, context.platform)) return candidate;
  }
  return findOnPath(name, context.env, context.platform);
}

export const androidEmulatorDetector: Detector = {
  id: "simulator.android",
  version: 1,
  type: "simulator",
  platforms: ["darwin", "linux", "win32"],
  intervalMs: 5 * 60_000,
  timeoutMs: 5000,
  async detect(context) {
    const emulator = androidSdkTool(context, "emulator", "emulator");
    if (!emulator) return [];
    const run = await context.exec(emulator, ["-list-avds"], {
      timeoutMs: 4000,
    });
    if (run.code !== 0)
      throw new Error(
        `emulator -list-avds failed: ${run.stderr.trim() || `exit ${run.code}`}`,
      );
    return run.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^[\w.-]+$/.test(line))
      .map((avd) => ({
        key: `simulator/android/${avd}`,
        type: "simulator" as const,
        platform: "android" as const,
        name: avd.replaceAll("_", " "),
        readiness: { ready: true, level: "installed" as const },
        backends: [
          {
            id: "android-emulator",
            mode: "listed" as const,
            readiness: { ready: true, level: "installed" as const },
          },
        ],
        details: { avd },
      }));
  },
};
