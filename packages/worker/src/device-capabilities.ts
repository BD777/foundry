// What the device a session runs on already provides. A workspace session is
// the person's own agent on their own device, so it uses the software that is
// installed here instead of Foundry shipping or downloading its own copies.
// Detection runs on the worker at launch, on whatever device it is.

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export interface InstalledBrowser {
  name: string;
  path: string;
}

const macApplications: Array<[string, string]> = [
  ["Google Chrome", "Google Chrome.app/Contents/MacOS/Google Chrome"],
  [
    "Google Chrome Canary",
    "Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  ],
  ["Chromium", "Chromium.app/Contents/MacOS/Chromium"],
  ["Microsoft Edge", "Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
  ["Brave", "Brave Browser.app/Contents/MacOS/Brave Browser"],
  ["Firefox", "Firefox.app/Contents/MacOS/firefox"],
];

const unixCommands: Array<[string, string]> = [
  ["Google Chrome", "google-chrome"],
  ["Google Chrome", "google-chrome-stable"],
  ["Chromium", "chromium"],
  ["Chromium", "chromium-browser"],
  ["Microsoft Edge", "microsoft-edge"],
  ["Microsoft Edge", "microsoft-edge-stable"],
  ["Brave", "brave-browser"],
  ["Firefox", "firefox"],
];

const linuxPaths: Array<[string, string]> = [
  ["Google Chrome", "/opt/google/chrome/chrome"],
  ["Microsoft Edge", "/opt/microsoft/msedge/msedge"],
  ["Chromium", "/snap/bin/chromium"],
];

const windowsPaths: Array<[string, string]> = [
  ["Google Chrome", "Google\\Chrome\\Application\\chrome.exe"],
  ["Microsoft Edge", "Microsoft\\Edge\\Application\\msedge.exe"],
  ["Brave", "BraveSoftware\\Brave-Browser\\Application\\brave.exe"],
  ["Firefox", "Mozilla Firefox\\firefox.exe"],
];

/** Browsers installed on this device, one entry per executable. */
export function installedBrowsers(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): InstalledBrowser[] {
  const candidates: Array<[string, string]> = [];
  if (platform === "darwin") {
    for (const root of ["/Applications", join(homedir(), "Applications")])
      for (const [name, path] of macApplications)
        candidates.push([name, join(root, path)]);
  } else if (platform === "win32") {
    for (const root of [
      env.ProgramFiles,
      env["ProgramFiles(x86)"],
      env.LOCALAPPDATA,
    ])
      if (root)
        for (const [name, path] of windowsPaths)
          candidates.push([name, join(root, path)]);
  } else {
    const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
    for (const [name, command] of unixCommands)
      for (const dir of dirs) candidates.push([name, join(dir, command)]);
    candidates.push(...linuxPaths);
  }
  const found = new Map<string, InstalledBrowser>();
  for (const [name, path] of candidates) {
    if (!existsSync(path)) continue;
    const real = realpathSync(path);
    if (!found.has(real)) found.set(real, { name, path });
  }
  return [...found.values()];
}

/**
 * What a workspace session is told about its device: to use what is
 * installed, which browsers there are, and how an image reaches the person.
 */
export function sessionDeviceNotes(
  workspacePath: string,
  browsers: InstalledBrowser[] = installedBrowsers(),
): string {
  const attachments = join(workspacePath, ".foundry", "attachments");
  return [
    "Foundry device notes:",
    "- This session runs on the person's own device. Use the software installed here when a task needs it; do not download or install a tool the device already has.",
    browsers.length
      ? `- Browsers installed on this device: ${browsers.map((browser) => `${browser.name} (${browser.path})`).join("; ")}. Run them directly (headless when no window is needed), each run with its own --user-data-dir in a temporary directory so the person's own browser profile is left untouched.`
      : "- No browser was found on this device.",
    `- To show an image to the person, save it under ${attachments}/ and put <image path="<its absolute path>"> in your reply.`,
  ].join("\n");
}
