// Resource Pool: capabilities already present on a device that sessions may
// use, such as an installed browser or macOS screen control. Foundry never
// installs a resource. On whatever device the worker runs, it discovers them,
// lists them for the server with its registration, tells each workspace
// session what it may use, and reclaims what a session left running when an
// input ends. See docs/architecture-modules.md §5.6.

import { execFileSync, spawnSync } from "node:child_process";

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import type { DeviceResource } from "@foundry/protocol";

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
  const script = [
    'ObjC.import("CoreGraphics");',
    'ObjC.import("ApplicationServices");',
    'ObjC.bindFunction("CGPreflightScreenCaptureAccess", ["bool", []]);',
    'ObjC.bindFunction("AXIsProcessTrusted", ["bool", []]);',
    "JSON.stringify({screenRecording: $.CGPreflightScreenCaptureAccess(), accessibility: $.AXIsProcessTrusted()})",
  ].join(" ");
  const output = execFileSync(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", script],
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

/** Everything this device offers sessions right now. */
export function discoverResources(): DeviceResource[] {
  return [...discoverBrowsers(), ...discoverComputerUse()];
}

/**
 * What a workspace session is told about its device: to use what is
 * installed, which resources it may use, and how an image reaches the person.
 */
export function sessionResourceNotes(
  workspacePath: string,
  resources: DeviceResource[] = discoverResources(),
  sessionId?: string,
): string {
  const browsers = resources.filter(
    (resource) => resource.kind === "browser" && resource.available,
  );
  const launchers = sessionId
    ? sessionBrowserLaunchers(sessionId, browsers)
    : {};
  const control = resources.find(
    (resource) => resource.kind === "computer_use",
  );
  const attachments = join(workspacePath, ".foundry", "attachments");
  return [
    "Foundry device notes:",
    "- This session runs on the person's own device. Use the software installed here when a task needs it; do not download or install a tool the device already has.",
    browsers.length
      ? Object.keys(launchers).length
        ? `- Browsers installed on this device: ${browsers.map((browser) => `${browser.name}: start it with ${launchers[browser.id]} (Foundry's launcher for ${browser.attributes?.path}; it takes the browser's own arguments)`).join("; ")}. The launcher reserves the browser for this session and it is closed when your reply ends. Run headless when no window is needed, each run with its own --user-data-dir under $TMPDIR so the person's own browser profile is left untouched.`
        : `- Browsers installed on this device: ${browsers.map((browser) => `${browser.name} (${browser.attributes?.path})`).join("; ")}. Run them directly (headless when no window is needed), each run with its own --user-data-dir in a temporary directory so the person's own browser profile is left untouched. Browser processes this session leaves running are closed when your reply ends.`
      : "- No browser was found on this device.",
    ...(control
      ? [
          control.available
            ? "- Screen control is granted on this macOS device (Screen Recording and Accessibility): you may capture the screen (screencapture) and drive applications (osascript)."
            : `- Screen control is not available on this device: ${control.detail}`,
        ]
      : []),
    `- To show an image to the person, save it under ${attachments}/ and put <image path="<its absolute path>"> in your reply.`,
  ].join("\n");
}

const scratchDirectories = new Map<string, string>();

/** Unix socket and profile paths stay short; TMPDIR can be deep. */
function shortTemporaryRoot(): string {
  const root = tmpdir();
  return root.length <= 64 ? root : "/tmp";
}

/**
 * A session's own temporary directory, its TMPDIR. What the session creates
 * there (a browser's profile or singleton files) marks processes as the
 * session's even after they rewrite their environment or leave its tree.
 */
export function sessionScratchDirectory(sessionId: string): string {
  let directory = scratchDirectories.get(sessionId);
  if (!directory) {
    directory = mkdtempSync(join(shortTemporaryRoot(), "fdy-"));
    scratchDirectories.set(sessionId, directory);
  }
  return directory;
}

/** TMPDIR and friends pointing at the session's scratch directory. */
export function sessionScratchEnvironment(
  sessionId: string,
): NodeJS.ProcessEnv {
  const directory = sessionScratchDirectory(sessionId);
  return { TMPDIR: directory, TMP: directory, TEMP: directory };
}

function leaseFile(scratch: string): string {
  return join(scratch, "browser-leases");
}

/**
 * Per-session launchers for the device's browsers: each records its process
 * id in the session's lease file and then becomes the browser (exec keeps the
 * id), so the session's browsers are known exactly, whatever the browser
 * later does to its environment and wherever its profile lives. Returns the
 * launcher path by resource id; none on Windows or for undispatched sessions.
 */
export function sessionBrowserLaunchers(
  sessionId: string,
  browsers: DeviceResource[],
): Record<string, string> {
  if (process.platform === "win32") return {};
  const scratch = sessionScratchDirectory(sessionId);
  const bin = join(scratch, "bin");
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const launchers: Record<string, string> = {};
  for (const browser of browsers) {
    const path = browser.attributes?.path;
    if (!path) continue;
    const launcher = join(bin, browser.id.replace(/^browser:/, ""));
    writeFileSync(
      launcher,
      [
        "#!/bin/sh",
        `# Foundry lease: ${browser.name} for session ${sessionId}.`,
        `echo $$ >> ${quote(leaseFile(scratch))}`,
        `exec ${quote(path)} "$@"`,
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    launchers[browser.id] = launcher;
  }
  return launchers;
}

function leasedPids(scratch: string | undefined): number[] {
  if (!scratch) return [];
  try {
    return readFileSync(leaseFile(scratch), "utf8")
      .split("\n")
      .map(Number)
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

interface ProcessEntry {
  pid: number;
  ppid: number;
  executable: string;
  /** Carries the session in its environment, arguments or open files. */
  marked: boolean;
}

function linuxProcesses(marker: string, scratch?: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const name of readdirSync("/proc")) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // The command name may contain spaces; ppid follows its closing paren.
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      const executable = readlinkSync(`/proc/${pid}/exe`).replace(
        / \(deleted\)$/,
        "",
      );
      let marked = false;
      try {
        marked = readFileSync(`/proc/${pid}/environ`, "utf8")
          .split("\0")
          .includes(marker);
      } catch {
        marked = false;
      }
      if (!marked && scratch) {
        marked = readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(scratch);
        if (!marked)
          for (const fd of readdirSync(`/proc/${pid}/fd`)) {
            try {
              if (readlinkSync(`/proc/${pid}/fd/${fd}`).startsWith(scratch)) {
                marked = true;
                break;
              }
            } catch {
              // Closed meanwhile.
            }
          }
      }
      entries.push({ pid, ppid, executable, marked });
    } catch {
      // Gone, or not ours.
    }
  }
  return entries;
}

function macProcesses(marker: string, scratch?: string): ProcessEntry[] {
  const list = (args: string[]) =>
    spawnSync("/bin/ps", args, { encoding: "utf8", timeout: 5000 }).stdout ??
    "";
  const entries = new Map<number, ProcessEntry>();
  for (const line of list(["-A", "-o", "pid=,ppid=,comm="]).split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match || Number(match[1]) === process.pid) continue;
    entries.set(Number(match[1]), {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      executable: match[3]!.trim(),
      marked: false,
    });
  }
  // With -E, ps appends each process's environment to its arguments.
  for (const line of list(["-A", "-E", "-ww", "-o", "pid=,command="]).split(
    "\n",
  )) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    const entry = match && entries.get(Number(match[1]));
    if (!entry) continue;
    const words = match[2]!;
    entry.marked =
      words.split(" ").includes(marker) ||
      Boolean(scratch && words.includes(scratch));
  }
  return [...entries.values()];
}

const browserProcessNames = browserFamilies.flatMap(
  (family) => family.processes,
);

function isBrowser(executable: string): boolean {
  const name = basename(executable);
  return browserProcessNames.some((prefix) => name.startsWith(prefix));
}

/**
 * Close the browsers a session started and left running. A browser process
 * belongs to the session when it, or a process of the same browser below it,
 * carries the session's id in its environment or uses the session's scratch
 * directory; the whole browser is closed from its topmost process. Browsers
 * can rewrite their own environment (Chrome on Linux does), which is why the
 * scratch directory and the climb to the top are needed. The agent runtime
 * and anything else the session started are left alone. Returns the
 * executables that were closed.
 */
export function reclaimSessionResources(sessionId: string): string[] {
  if (!sessionId) return [];
  const marker = `FOUNDRY_SESSION_ID=${sessionId}`;
  const scratch = scratchDirectories.get(sessionId);
  const entries =
    process.platform === "linux"
      ? linuxProcesses(marker, scratch)
      : process.platform === "darwin"
        ? macProcesses(marker, scratch)
        : [];
  const byPid = new Map(entries.map((entry) => [entry.pid, entry]));
  const targets = new Map<number, ProcessEntry>();
  // Leased browsers first: exact, whatever the browser did since.
  for (const pid of leasedPids(scratch)) {
    const entry = byPid.get(pid);
    if (entry && isBrowser(entry.executable)) targets.set(pid, entry);
  }
  for (const entry of entries) {
    if (!entry.marked || !isBrowser(entry.executable)) continue;
    let top = entry;
    for (;;) {
      const parent = byPid.get(top.ppid);
      if (!parent || !isBrowser(parent.executable)) break;
      top = parent;
    }
    targets.set(top.pid, top);
    targets.set(entry.pid, entry);
  }
  if (scratch) writeFileSync(leaseFile(scratch), "");
  const reclaimed: string[] = [];
  for (const target of targets.values()) {
    try {
      process.kill(target.pid, "SIGKILL");
      reclaimed.push(basename(target.executable));
    } catch {
      // Already exited.
    }
  }
  return reclaimed;
}
