// Installed browsers: one instance per browser family found, by file
// checks only (application bundles, PATH, fixed install folders and the
// Playwright download cache). Moved from resource-pool.ts; what sessions
// are told is unchanged (discoverBrowsers).

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { DeviceResource } from "@bd777/foundry-protocol";
import {
  resourcePlatform,
  type DetectedInstance,
  type Detector,
} from "../detector.js";

interface BrowserFamily {
  id: string;
  name: string;
  /** Executables inside an application bundle, under /Applications. */
  mac: string[];
  /** Commands looked up on PATH (Linux and other Unix). */
  commands: string[];
  /** Fixed Linux install locations outside PATH. */
  linux: string[];
  /** Paths under Program Files / LocalAppData. */
  windows: string[];
  /** Executable names of its processes, including helpers, by prefix. */
  processes: string[];
  /** Also look in Playwright's browser cache (browsers other tools downloaded). */
  playwright?: boolean;
}

const browserFamilies: BrowserFamily[] = [
  {
    id: "google-chrome",
    name: "Google Chrome",
    mac: ["Google Chrome.app/Contents/MacOS/Google Chrome"],
    commands: ["google-chrome", "google-chrome-stable"],
    linux: ["/opt/google/chrome/chrome"],
    windows: ["Google\\Chrome\\Application\\chrome.exe"],
    processes: ["chrome", "Google Chrome"],
  },
  {
    id: "google-chrome-canary",
    name: "Google Chrome Canary",
    mac: ["Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"],
    commands: [],
    linux: [],
    windows: [],
    processes: ["Google Chrome Canary"],
  },
  {
    id: "chromium",
    name: "Chromium",
    mac: ["Chromium.app/Contents/MacOS/Chromium"],
    commands: ["chromium", "chromium-browser"],
    linux: ["/snap/bin/chromium"],
    windows: [],
    processes: ["chromium", "Chromium"],
  },
  {
    id: "microsoft-edge",
    name: "Microsoft Edge",
    mac: ["Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
    commands: ["microsoft-edge", "microsoft-edge-stable"],
    linux: ["/opt/microsoft/msedge/msedge"],
    windows: ["Microsoft\\Edge\\Application\\msedge.exe"],
    processes: ["msedge", "Microsoft Edge"],
  },
  {
    id: "brave",
    name: "Brave",
    mac: ["Brave Browser.app/Contents/MacOS/Brave Browser"],
    commands: ["brave-browser"],
    linux: ["/opt/brave.com/brave/brave"],
    windows: ["BraveSoftware\\Brave-Browser\\Application\\brave.exe"],
    processes: ["brave", "Brave Browser"],
  },
  {
    id: "playwright-chromium",
    name: "Chromium (Playwright)",
    mac: [],
    commands: [],
    linux: [],
    windows: [],
    processes: ["chrome", "Chromium", "Google Chrome for Testing"],
    playwright: true,
  },
  {
    id: "firefox",
    name: "Firefox",
    mac: ["Firefox.app/Contents/MacOS/firefox"],
    commands: ["firefox"],
    linux: [],
    windows: ["Mozilla Firefox\\firefox.exe"],
    processes: ["firefox"],
  },
];

/**
 * Chromium builds in Playwright's browser cache, newest first. Tools on the
 * device (Playwright, agent browsers) may have downloaded them already.
 */
function playwrightChromiumPaths(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string[] {
  const home = env.HOME || homedir();
  const root =
    env.PLAYWRIGHT_BROWSERS_PATH ||
    (platform === "darwin"
      ? join(home, "Library", "Caches", "ms-playwright")
      : platform === "win32"
        ? join(env.LOCALAPPDATA ?? home, "ms-playwright")
        : join(home, ".cache", "ms-playwright"));
  let builds: string[];
  try {
    builds = readdirSync(root)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
  } catch {
    return [];
  }
  const inside =
    platform === "darwin"
      ? [
          "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
          "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
          "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        ]
      : platform === "win32"
        ? ["chrome-win/chrome.exe", "chrome-win64/chrome.exe"]
        : ["chrome-linux64/chrome", "chrome-linux/chrome"];
  return builds.flatMap((build) =>
    inside.map((path) => join(root, build, path)),
  );
}

function browserPaths(
  family: BrowserFamily,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string[] {
  if (family.playwright) return playwrightChromiumPaths(platform, env);
  if (platform === "darwin")
    return ["/Applications", join(homedir(), "Applications")].flatMap((root) =>
      family.mac.map((path) => join(root, path)),
    );
  if (platform === "win32")
    return [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA]
      .filter((root): root is string => Boolean(root))
      .flatMap((root) => family.windows.map((path) => join(root, path)));
  const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  return [
    ...family.commands.flatMap((command) =>
      dirs.map((dir) => join(dir, command)),
    ),
    ...family.linux,
  ];
}

/** Installed browsers, one resource per browser family found. */
export function discoverBrowsers(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): DeviceResource[] {
  const resources: DeviceResource[] = [];
  for (const family of browserFamilies) {
    const path = browserPaths(family, platform, env).find(existsSync);
    if (!path) continue;
    resources.push({
      id: `browser:${family.id}`,
      kind: "browser",
      name: family.name,
      available: true,
      attributes: { path },
    });
  }
  return resources;
}

/** Executable name prefixes of every browser family's processes. */
export const browserProcessNames = browserFamilies.flatMap(
  (family) => family.processes,
);

export const browserDetector: Detector = {
  id: "browser",
  version: 1,
  type: "browser",
  platforms: ["darwin", "linux", "win32"],
  intervalMs: 10 * 60_000,
  timeoutMs: 3000,
  async detect({ platform, env }) {
    return discoverBrowsers(platform, env).map((browser): DetectedInstance => ({
      key: `browser/${browser.id.replace(/^browser:/, "")}`,
      type: "browser",
      platform: resourcePlatform(platform),
      name: browser.name,
      readiness: { ready: true, level: "installed" },
      details: browser.attributes,
    }));
  },
};
