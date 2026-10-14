// Resource Pool: capabilities already present on a device that sessions may
// use, such as an installed browser or macOS screen control. Foundry never
// installs a resource. Discovery lives in the resources module
// (resources/); this module tells each workspace session what it may use,
// and reclaims what a session left running when an input ends and its
// scratch directory once it is idle. See docs/architecture-modules.md §5.6.

import { spawnSync } from "node:child_process";

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import type { DeviceResource } from "@bd777/foundry-protocol";
import { discoverResources } from "./resources/index.js";
import { browserProcessNames } from "./resources/detectors/browser.js";
import { foundryStatePath } from "./state-root.js";
import { writePrivateJSONAtomic } from "./storage.js";
import { errorMessage } from "./utils.js";

// What tells the browsers apart, so the session picks the one a task needs.
const browserChoiceNote =
  "Pick the browser per task: a Playwright or Chrome for Testing build is isolated and never updates itself, so prefer it for headless work; an everyday browser (Google Chrome, Edge) may try to update itself when it starts, which macOS can block with an App Management notice. A fresh --user-data-dir has none of the person's sign-ins: when a task needs their signed-in browser, use their running browser through screen control where it is available, or ask them.";

/**
 * What a workspace session is told about its device: to use what is
 * installed, which resources it may use, how an image reaches the person,
 * and which Foundry session it is.
 */
export function sessionResourceNotes(
  workspacePath: string,
  resources: DeviceResource[] = discoverResources(),
  sessionId?: string,
  foundrySessionId?: string,
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
        ? `- Browsers installed on this device: ${browsers.map((browser) => `${browser.name}: start it with ${launchers[browser.id]} (Foundry's launcher for ${browser.attributes?.path}; it takes the browser's own arguments)`).join("; ")}. The launcher reserves the browser for this session and it is closed when your reply ends. Run headless when no window is needed, each run with its own --user-data-dir under $TMPDIR so the person's own browser profile is left untouched. ${browserChoiceNote}`
        : `- Browsers installed on this device: ${browsers.map((browser) => `${browser.name} (${browser.attributes?.path})`).join("; ")}. Run them directly (headless when no window is needed), each run with its own --user-data-dir in a temporary directory so the person's own browser profile is left untouched. Browser processes this session leaves running are closed when your reply ends. ${browserChoiceNote}`
      : "- No browser was found on this device.",
    ...(control
      ? [
          control.available
            ? "- Screen control is granted on this macOS device (Screen Recording and Accessibility): you may capture the screen (screencapture) and drive applications (osascript)."
            : `- Screen control is not available on this device: ${control.detail}`,
        ]
      : []),
    `- To show an image to the person, save it under ${attachments}/ and put <image path="<its absolute path>"> in your reply.`,
    "- When your reply mentions files you created or changed, cite each by its absolute or workspace-relative path in inline code (for example `docs/summary.md`), so the person can open it from the reply.",
    ...(foundrySessionId ? [foundrySessionNote(foundrySessionId)] : []),
  ].join("\n");
}

/**
 * Which Foundry session this is, what Foundry ids and links name, and that
 * the foundry skill also works through other sessions.
 */
export function foundrySessionNote(sessionId: string): string {
  return `- You are Foundry session ${sessionId}. Ids such as sess_…, native_claude_…, native_codex_…, ws_… and dev_…, and Foundry chat links (…/chats/<id>), name Foundry sessions, chats, workspaces and devices; the foundry skill reads them, and starts, steers and waits on sessions on this or other devices.`;
}

// A session's scratch directory lives as long as the session, not as this
// process: the directory each session got is recorded in the worker's state
// root, so a restarted or updated worker gives the session the same one. A
// directory unused for sessionScratchIdleMs() is removed once nothing of its
// session runs. Only recorded directories are ever removed: other workers on
// the device (their own state roots) make theirs under the same prefix.
// Directories a session got before records were kept (one per worker run)
// are adopted into its record as earlier directories once the worker proves
// they are the session's (see session-scratch-adoption.ts), and go with it.

const defaultScratchIdleMs = 3 * 24 * 60 * 60 * 1000;
/** How often a session's use is written to its record at most. */
const scratchUseRecordIntervalMs = 60_000;
/** The name mkdtemp gives a scratch directory. */
const scratchName = /^fdy-[A-Za-z0-9]{6}$/;

/**
 * How long a session's scratch directory outlives its last use:
 * FOUNDRY_SESSION_SCRATCH_IDLE_MS, three days by default.
 */
export function sessionScratchIdleMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const configured = Number(env.FOUNDRY_SESSION_SCRATCH_IDLE_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : defaultScratchIdleMs;
}

interface ScratchRecord {
  sessionId: string;
  directory: string;
  lastUsedAt: string;
  /** Directories the session had before, removed together with directory. */
  previousDirectories?: string[];
}

/** Directories this process knows, with when it last recorded their use. */
const scratchDirectories = new Map<
  string,
  { directory: string; recordedAt: number }
>();

function scratchRecordsDirectory(): string {
  return foundryStatePath("session-scratch");
}

function scratchRecordPath(sessionId: string): string {
  const name = /^[A-Za-z0-9_-]{1,128}$/.test(sessionId)
    ? sessionId
    : `h-${createHash("sha256").update(sessionId).digest("hex").slice(0, 40)}`;
  return join(scratchRecordsDirectory(), `${name}.json`);
}

function parseScratchRecord(path: string): ScratchRecord | undefined {
  try {
    const value = JSON.parse(
      readFileSync(path, "utf8"),
    ) as Partial<ScratchRecord>;
    if (
      typeof value.sessionId === "string" &&
      typeof value.directory === "string" &&
      isAbsolute(value.directory) &&
      typeof value.lastUsedAt === "string"
    )
      return {
        ...(value as ScratchRecord),
        previousDirectories: Array.isArray(value.previousDirectories)
          ? value.previousDirectories.filter(
              (directory): directory is string =>
                typeof directory === "string" && isAbsolute(directory),
            )
          : undefined,
      };
  } catch {
    // Missing or unreadable: no record.
  }
  return undefined;
}

function readScratchRecord(sessionId: string): ScratchRecord | undefined {
  const record = parseScratchRecord(scratchRecordPath(sessionId));
  return record?.sessionId === sessionId ? record : undefined;
}

/** Notes that the session uses its directory now, at most once a minute. */
function recordScratchUse(sessionId: string, directory: string): void {
  const known = scratchDirectories.get(sessionId);
  const now = Date.now();
  if (
    known?.directory === directory &&
    now - known.recordedAt < scratchUseRecordIntervalMs
  )
    return;
  scratchDirectories.set(sessionId, { directory, recordedAt: now });
  const previousDirectories = readScratchRecord(
    sessionId,
  )?.previousDirectories?.filter((previous) => previous !== directory);
  const record: ScratchRecord = {
    sessionId,
    directory,
    lastUsedAt: new Date(now).toISOString(),
    ...(previousDirectories?.length ? { previousDirectories } : {}),
  };
  try {
    writePrivateJSONAtomic(scratchRecordPath(sessionId), record);
  } catch (error) {
    // The session keeps working; only a restart would not find the directory.
    console.warn(
      `Could not record the scratch directory of session ${sessionId}: ${errorMessage(error)}`,
    );
  }
}

function isOwnDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return (
      stat.isDirectory() &&
      (process.getuid === undefined || stat.uid === process.getuid())
    );
  } catch {
    return false;
  }
}

/** The directory, made again when it was removed, if it is this user's own. */
function ownDirectory(path: string): string | undefined {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
  }
  return isOwnDirectory(path) ? path : undefined;
}

/** Unix socket and profile paths stay short; TMPDIR can be deep. */
function shortTemporaryRoot(): string {
  const root = tmpdir();
  return root.length <= 64 ? root : "/tmp";
}

/**
 * A session's own temporary directory, its TMPDIR. What the session creates
 * there (a browser's profile or singleton files) marks processes as the
 * session's even after they rewrite their environment or leave its tree.
 * The session keeps it across worker restarts; one removed from outside
 * (tmpfiles, macOS's cleanup of $TMPDIR) is made again at the same path.
 */
export function sessionScratchDirectory(sessionId: string): string {
  const known = knownSessionScratchDirectory(sessionId);
  const directory =
    (known ? ownDirectory(known) : undefined) ??
    mkdtempSync(join(shortTemporaryRoot(), "fdy-"));
  recordScratchUse(sessionId, directory);
  return directory;
}

/**
 * The session's scratch directory if this worker made one, in this process
 * or an earlier one; never makes one.
 */
export function knownSessionScratchDirectory(
  sessionId: string,
): string | undefined {
  const known = scratchDirectories.get(sessionId);
  if (known) return known.directory;
  const record = readScratchRecord(sessionId);
  if (!record) return undefined;
  scratchDirectories.set(sessionId, {
    directory: record.directory,
    recordedAt: 0,
  });
  return record.directory;
}

/**
 * Scratch directories in the temporary root that are this user's and that no
 * record of this worker names: made by a worker run that kept no records, or
 * by another worker on the device.
 */
export function unrecordedScratchDirectories(): string[] {
  const root = shortTemporaryRoot();
  const recorded = new Set<string>();
  for (const record of scratchRecords())
    for (const directory of [
      record.directory,
      ...(record.previousDirectories ?? []),
    ])
      recorded.add(directory);
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names
    .filter((name) => scratchName.test(name))
    .map((name) => join(root, name))
    .filter((path) => !recorded.has(path) && isOwnDirectory(path));
}

function scratchRecords(): ScratchRecord[] {
  const directory = scratchRecordsDirectory();
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) =>
      /^[^.].*\.json$/.test(name),
    );
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const record = parseScratchRecord(join(directory, name));
    return record ? [record] : [];
  });
}

/**
 * Takes directories proven to be the session's into its record. A session
 * with no record yet keeps using the most recently changed of them; the
 * others, and all of them for a session with a record, become its earlier
 * directories. lastUsedAt is when the session last used any of them.
 * Returns the directory the session now uses.
 */
export function adoptSessionScratchDirectories(
  sessionId: string,
  directories: readonly string[],
  lastUsedAt: number,
): string | undefined {
  const existing = readScratchRecord(sessionId);
  const changed = (path: string) => {
    try {
      return lstatSync(path).mtimeMs;
    } catch {
      return -1;
    }
  };
  const candidates = [...new Set(directories)]
    .filter((directory) => isAbsolute(directory))
    .sort((left, right) => changed(right) - changed(left));
  const directory =
    existing?.directory ??
    candidates.find((candidate) => isOwnDirectory(candidate));
  if (!directory) return undefined;
  const previousDirectories = [
    ...new Set([...(existing?.previousDirectories ?? []), ...candidates]),
  ].filter((previous) => previous !== directory);
  const used = Math.max(
    lastUsedAt,
    existing ? Date.parse(existing.lastUsedAt) || 0 : 0,
  );
  writePrivateJSONAtomic(scratchRecordPath(sessionId), {
    sessionId,
    directory,
    lastUsedAt: new Date(used).toISOString(),
    ...(previousDirectories.length ? { previousDirectories } : {}),
  } satisfies ScratchRecord);
  if (!scratchDirectories.has(sessionId))
    scratchDirectories.set(sessionId, { directory, recordedAt: 0 });
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
        const environment = readFileSync(`/proc/${pid}/environ`, "utf8").split(
          "\0",
        );
        // TMPDIR inherited by processes that dropped the session's id.
        marked =
          environment.includes(marker) ||
          Boolean(
            scratch && environment.some((entry) => entry.includes(scratch)),
          );
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

function isBrowser(executable: string): boolean {
  const name = basename(executable);
  return browserProcessNames.some((prefix) => name.startsWith(prefix));
}

interface SessionProcesses {
  /** The session's browsers, each with its topmost browser process. */
  browsers: Map<number, ProcessEntry>;
  /** Its other processes: the agent, background work, servers it left. */
  others: ProcessEntry[];
}

/**
 * The running processes that belong to a session. A browser process belongs
 * to it when it is leased to the session, or when it or a process of the same
 * browser below it carries the session's id in its environment or uses the
 * session's scratch directory. Browsers can rewrite their own environment
 * (Chrome on Linux does), which is why the scratch directory and the climb to
 * the top are needed.
 */
function sessionProcesses(
  sessionId: string,
  scratch: string | undefined,
): SessionProcesses {
  const marker = `FOUNDRY_SESSION_ID=${sessionId}`;
  const entries =
    process.platform === "linux"
      ? linuxProcesses(marker, scratch)
      : process.platform === "darwin"
        ? macProcesses(marker, scratch)
        : [];
  const byPid = new Map(entries.map((entry) => [entry.pid, entry]));
  const browsers = new Map<number, ProcessEntry>();
  const others: ProcessEntry[] = [];
  // Leased browsers first: exact, whatever the browser did since.
  for (const pid of leasedPids(scratch)) {
    const entry = byPid.get(pid);
    if (entry && isBrowser(entry.executable)) browsers.set(pid, entry);
  }
  for (const entry of entries) {
    if (!entry.marked) continue;
    if (!isBrowser(entry.executable)) {
      others.push(entry);
      continue;
    }
    let top = entry;
    for (;;) {
      const parent = byPid.get(top.ppid);
      if (!parent || !isBrowser(parent.executable)) break;
      top = parent;
    }
    browsers.set(top.pid, top);
    browsers.set(entry.pid, entry);
  }
  return { browsers, others };
}

function closeProcesses(targets: Iterable<ProcessEntry>): string[] {
  const closed: string[] = [];
  for (const target of targets) {
    try {
      process.kill(target.pid, "SIGKILL");
      closed.push(basename(target.executable));
    } catch {
      // Already exited.
    }
  }
  return closed;
}

/** Empties the lease file; a scratch directory removed from outside has none. */
function clearLeases(scratch: string): void {
  try {
    writeFileSync(leaseFile(scratch), "");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR")
      console.warn(
        `Could not clear the browser leases in ${scratch}: ${errorMessage(error)}`,
      );
  }
}

/**
 * Close the browsers a session started and left running (see
 * sessionProcesses); the whole browser is closed from its topmost process.
 * The agent runtime and anything else the session started are left alone.
 * Returns the executables that were closed.
 */
export function reclaimSessionResources(sessionId: string): string[] {
  if (!sessionId) return [];
  const scratch = knownSessionScratchDirectory(sessionId);
  const { browsers } = sessionProcesses(sessionId, scratch);
  if (scratch) {
    clearLeases(scratch);
    // An input ended: the session used its directory until now.
    recordScratchUse(sessionId, scratch);
  }
  return closeProcesses(browsers.values());
}

export interface SessionScratchSweep {
  /** Whether the session still runs an input or background work here. */
  busy?: (sessionId: string) => boolean;
  /** How long a directory outlives its session's last use. */
  idleMs?: number;
  now?: () => number;
}

export interface RemovedSessionScratch {
  sessionId: string;
  directory: string;
  /** Earlier directories of the session removed with it. */
  previousDirectories?: string[];
  /** Browsers of the session that were closed first. */
  closed: string[];
}

/** How long closed browsers get to exit before a directory is removed. */
const browserExitWaitMs = 3000;

/**
 * Removes the scratch directories this worker recorded, in this process or
 * an earlier one, for sessions unused for longer than idleMs: the session's
 * browsers are closed first, then the directory and its record go. A session
 * still running an input, background work or any other process of its own
 * keeps its directory, as does one used again meanwhile.
 */
export async function sweepSessionScratchDirectories(
  options: SessionScratchSweep = {},
): Promise<RemovedSessionScratch[]> {
  const idleMs = options.idleMs ?? sessionScratchIdleMs();
  const now = options.now ?? Date.now;
  const idleRecord = (sessionId: string): ScratchRecord | undefined => {
    const record = readScratchRecord(sessionId);
    if (!record || options.busy?.(sessionId)) return undefined;
    const lastUsed = Math.max(
      Date.parse(record.lastUsedAt) || 0,
      scratchDirectories.get(sessionId)?.recordedAt ?? 0,
    );
    return now() - lastUsed > idleMs ? record : undefined;
  };
  const recordsDirectory = scratchRecordsDirectory();
  let names: string[];
  try {
    names = readdirSync(recordsDirectory).filter((name) =>
      /^[^.].*\.json$/.test(name),
    );
  } catch {
    return [];
  }
  const removed: RemovedSessionScratch[] = [];
  for (const name of names) {
    const sessionId = parseScratchRecord(
      join(recordsDirectory, name),
    )?.sessionId;
    const record = sessionId ? idleRecord(sessionId) : undefined;
    if (!sessionId || !record) continue;
    const { directory } = record;
    const directories = [directory, ...(record.previousDirectories ?? [])];
    // What runs of the session, or uses any of its directories.
    const processesOf = () => {
      const each = directories.map((path) => sessionProcesses(sessionId, path));
      return {
        browsers: new Map(each.flatMap((found) => [...found.browsers])),
        others: each.flatMap((found) => found.others),
      };
    };
    try {
      let processes = processesOf();
      const closed = closeProcesses(processes.browsers.values());
      const deadline = Date.now() + browserExitWaitMs;
      while (processes.browsers.size > 0 && Date.now() < deadline) {
        await new Promise((done) => setTimeout(done, 100));
        processes = processesOf();
      }
      // Decided with nothing awaited before the removal.
      const current = idleRecord(sessionId);
      if (
        processes.browsers.size > 0 ||
        processes.others.length > 0 ||
        current?.directory !== directory ||
        (current.previousDirectories ?? []).some(
          (previous) => !directories.includes(previous),
        )
      )
        continue;
      for (const path of directories)
        if (scratchName.test(basename(path)) && isOwnDirectory(path))
          rmSync(path, { recursive: true, force: true });
        else if (existsSync(path))
          console.warn(
            `Not removing ${path} of session ${sessionId}: it is not a scratch directory of this user.`,
          );
      rmSync(scratchRecordPath(sessionId), { force: true });
      scratchDirectories.delete(sessionId);
      removed.push({
        sessionId,
        directory,
        ...(directories.length > 1
          ? { previousDirectories: directories.slice(1) }
          : {}),
        closed,
      });
    } catch (error) {
      console.warn(
        `Could not remove the scratch directory ${directory} of session ${sessionId}: ${errorMessage(error)}`,
      );
    }
  }
  return removed;
}

let scratchSweepTimer: NodeJS.Timeout | undefined;

/**
 * Sweeps this worker's idle scratch directories now, including those its
 * earlier processes left, and then regularly.
 */
export function startSessionScratchSweeps(
  busy: (sessionId: string) => boolean,
): void {
  if (scratchSweepTimer) return;
  const idleMs = sessionScratchIdleMs();
  let sweeping = false;
  const sweep = (): void => {
    if (sweeping) return;
    sweeping = true;
    sweepSessionScratchDirectories({ busy, idleMs })
      .then((removed) => {
        for (const {
          sessionId,
          directory,
          previousDirectories,
          closed,
        } of removed)
          console.log(
            `Removed the scratch directory ${directory} of idle session ${sessionId}${previousDirectories?.length ? ` and its earlier ${previousDirectories.join(", ")}` : ""}${closed.length ? `; closed ${closed.join(", ")}` : ""}`,
          );
      })
      .catch((error) =>
        console.warn(
          `Sweeping session scratch directories failed: ${errorMessage(error)}`,
        ),
      )
      .finally(() => {
        sweeping = false;
      });
  };
  sweep();
  scratchSweepTimer = setInterval(
    sweep,
    Math.min(60 * 60_000, Math.max(10_000, idleMs / 4)),
  );
  scratchSweepTimer.unref();
}
