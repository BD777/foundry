import {
  externalConnectionDataHome,
  externalConnectionDataHomes,
} from "./session-ambient.js";
import {
  configuredAgentProfiles,
  profileID,
  profileFingerprint,
} from "./profiles.js";
// Native chat discovery: finds Codex/Claude conversation logs on the local
// filesystem, reads and caches them, and projects them as Foundry chat
// threads. What the log lines mean is native-chat-records.ts.

import { existsSync, readFileSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import type { Stats } from "node:fs";
import { open as openFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { nativeChatTranscript } from "./native-chat-transcript.js";
import {
  claudeSessionHandoffContext,
  claudeSessionPreview,
  codexSessionHandoffContext,
  codexSessionPreview,
  conversationActivity,
  nativeChatRecap,
  parseJSONRecord,
} from "./native-chat-records.js";
import type {
  AgentProfileProjection,
  ChatThread,
  NativeHistoryReadPayload,
  WorkerRuntimeId,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import type { FileHandle } from "node:fs/promises";

interface CodexSessionIndexEntry {
  id: string;
  thread_name?: string;
  updated_at?: string;
}

interface NativeChatCandidate {
  archived?: boolean;
  id: string;
  profileFingerprint?: string;
  profileId?: string;
  profileLabel?: string;
  provider: Exclude<WorkerRuntimeId, "mock">;
  title: string;
  preview: string;
  handoffContext?: string;
  transcript?: ChatThread["transcript"];
  transcriptBefore?: number;
  answerRevision?: string;
  recentMessages?: ChatThread["recentMessages"];
  status?: ChatThread["status"];
  updatedAt: Date;
  workspacePath: string;
}

interface NativeChatCacheEntry {
  mtimeMs: number;
  size: number;
  value: Promise<NativeChatCandidate | undefined>;
}

const codexNativeChatCache = new Map<string, NativeChatCacheEntry>();
const claudeNativeChatCache = new Map<string, NativeChatCacheEntry>();
const nativeSessionHeaderByteLimit = 256 * 1024;
// A chat carries its log's latest part of about this size; older parts are
// read a page of this size at a time when someone scrolls up to them.
const nativeSessionTranscriptByteLimit = 1024 * 1024;
// One log line larger than this (a pasted image, say) is left out of a page.
const nativeLogLineLimit = 16 * 1024 * 1024;
// A chat's latest part, or a page, reaches back up to this far for a step
// to show: a long run of tool output or bookkeeping is not a whole page.
const nativeLogReachLimit = 8 * 1024 * 1024;

export async function nativeChatThreadsForWorkspace(
  workspace: WorkspaceProjection,
  profiles: AgentProfileProjection[],
  limit = 60,
  includeIds: ReadonlySet<string> = new Set(),
): Promise<ChatThread[]> {
  const nativeProfiles = new Map<
    Exclude<WorkerRuntimeId, "mock">,
    AgentProfileProjection | undefined
  >([
    ["codex", nativeProfileForRuntime(profiles, "codex")],
    ["claude", nativeProfileForRuntime(profiles, "claude")],
  ]);
  const [codexChats, claudeChats] = await Promise.all([
    codexNativeChatThreadsForWorkspace(workspace),
    claudeNativeChatThreadsForWorkspace(workspace),
  ]);
  return [...codexChats, ...claudeChats]
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .filter(
      (candidate, index) =>
        index < limit ||
        candidate.archived ||
        includeIds.has(`native_${candidate.provider}_${candidate.id}`),
    )
    .map((candidate) => {
      const profile = nativeProfiles.get(candidate.provider);
      return {
        id: `native_${candidate.provider}_${candidate.id}`,
        handoffContext: candidate.handoffContext,
        transcript: candidate.transcript,
        ...(candidate.transcriptBefore
          ? { transcriptBefore: candidate.transcriptBefore }
          : {}),
        answerRevision: candidate.answerRevision,
        recentMessages: candidate.recentMessages,
        status: candidate.status,
        archived: candidate.archived,
        nativeSessionId: candidate.id,
        preview: candidate.preview,
        provider: candidate.provider,
        profileFingerprint:
          candidate.profileFingerprint ?? profile?.fingerprint,
        profileId: candidate.profileId ?? profile?.id,
        profileLabel: candidate.profileLabel ?? profile?.label,
        readonly: false,
        title: candidate.title,
        // Its last conversation activity; lists label it themselves, so
        // time passing never changes what is uploaded.
        updatedAt: candidate.updatedAt.toISOString(),
        workspaceId: workspace.id,
      };
    });
}

/**
 * The page of a native chat's log that ends at byte `before`, for someone
 * scrolling back: only a log of this workspace, found by its id among the
 * logs the chat list reads.
 */
export async function nativeChatHistory(
  workspacePath: string,
  provider: Exclude<WorkerRuntimeId, "mock">,
  nativeSessionId: string,
  before: number,
): Promise<NativeHistoryReadPayload> {
  if (!Number.isSafeInteger(before) || before <= 0)
    throw new Error("before must be a positive byte offset");
  const path = await nativeChatLogPath(
    resolve(workspacePath),
    provider,
    nativeSessionId,
  );
  if (!path) throw new Error("This native chat's log is not on this device.");
  const size = statSync(path).size;
  const page = await readShownWindow(
    path,
    Math.min(before, size),
    provider,
    (transcript) => transcript.length > 0,
  );
  return { transcript: page.transcript, before: page.start };
}

/**
 * readLogWindow, reaching further back (up to nativeLogReachLimit) while
 * what the window shows does not satisfy `enough`.
 */
async function readShownWindow(
  sessionPath: string,
  end: number,
  provider: Exclude<WorkerRuntimeId, "mock">,
  enough: (transcript: NonNullable<ChatThread["transcript"]>) => boolean,
): Promise<LogWindow & { transcript: NonNullable<ChatThread["transcript"]> }> {
  let window = await readLogWindow(
    sessionPath,
    end,
    nativeSessionTranscriptByteLimit,
  );
  let transcript = nativeChatTranscript(window.lines, provider, window.offsets);
  while (
    window.start > 0 &&
    end - window.start < nativeLogReachLimit &&
    !enough(transcript)
  ) {
    const older = await readLogWindow(
      sessionPath,
      window.start,
      nativeSessionTranscriptByteLimit,
    );
    window = {
      lines: [...older.lines, ...window.lines],
      offsets: [...older.offsets, ...window.offsets],
      start: older.start,
    };
    transcript = nativeChatTranscript(window.lines, provider, window.offsets);
  }
  return { ...window, transcript };
}

/** A transcript holds a turn of the conversation, not only its steps. */
function holdsTurn(transcript: NonNullable<ChatThread["transcript"]>): boolean {
  return transcript.some(
    (message) => message.kind === "user" || message.kind === "assistant",
  );
}

export async function nativeChatLogPath(
  workspacePath: string,
  provider: Exclude<WorkerRuntimeId, "mock">,
  id: string,
): Promise<string | undefined> {
  const [homes, folder, depth, cache, parse] =
    provider === "codex"
      ? ([
          codexHomeCandidates(),
          "sessions",
          codexSessionDepth,
          codexNativeChatCache,
          parseCodexSessionCandidate,
        ] as const)
      : ([
          claudeHomeCandidates(),
          "projects",
          claudeSessionDepth,
          claudeNativeChatCache,
          parseClaudeSessionCandidate,
        ] as const);
  for (const home of homes) {
    // Both runtimes name a log after its session id.
    const paths = (
      await Promise.all([
        jsonlFiles(resolve(home, folder), 2500, depth),
        jsonlFiles(
          resolve(
            home,
            "archived_sessions",
            provider === "claude" ? "projects" : "",
          ),
          2500,
          depth,
        ),
      ])
    )
      .flat()
      .filter((path) => basename(path).includes(id));
    for (const path of paths) {
      const candidate = await cachedNativeChatCandidate(cache, path, parse);
      if (candidate?.id === id && candidate.workspacePath === workspacePath)
        return path;
    }
  }
  return undefined;
}

function nativeProfileForRuntime(
  profiles: AgentProfileProjection[],
  runtime: Exclude<WorkerRuntimeId, "mock">,
): AgentProfileProjection | undefined {
  return (
    profiles.find(
      (profile) =>
        profile.runtime === runtime && profile.connectionType === "local_login",
    ) ?? profiles.find((profile) => profile.runtime === runtime)
  );
}

async function codexNativeChatThreadsForWorkspace(
  workspace: WorkspaceProjection,
): Promise<NativeChatCandidate[]> {
  const workspacePath = resolve(workspace.localPath);
  const byID = new Map<string, NativeChatCandidate>();

  for (const codexHome of codexHomeCandidates()) {
    const titleIndex = codexSessionIndex(codexHome);
    const sessionsRoot = resolve(codexHome, "sessions");
    const archivedRoot = resolve(codexHome, "archived_sessions");
    const sessionPaths = (
      await Promise.all([
        jsonlFiles(sessionsRoot, 2500, codexSessionDepth),
        jsonlFiles(archivedRoot, 2500, codexSessionDepth),
      ])
    ).flat();
    for (let index = 0; index < sessionPaths.length; index += 1) {
      const sessionPath = sessionPaths[index];
      if (!sessionPath) {
        continue;
      }
      const parsed = await cachedNativeChatCandidate(
        codexNativeChatCache,
        sessionPath,
        parseCodexSessionCandidate,
      );
      if (index % 4 === 3) {
        await yieldToEventLoop();
      }
      if (!parsed || parsed.workspacePath !== workspacePath) {
        continue;
      }
      const indexed = titleIndex.get(parsed.id);
      const candidate = {
        ...parsed,
        archived: sessionPath.startsWith(archivedRoot + "/"),
        title:
          indexed?.thread_name?.trim() || parsed.preview || "Codex session",
      };
      const current = byID.get(candidate.id);
      if (!current || candidate.updatedAt > current.updatedAt) {
        byID.set(candidate.id, candidate);
      }
    }
  }

  return [...byID.values()];
}

async function claudeNativeChatThreadsForWorkspace(
  workspace: WorkspaceProjection,
): Promise<NativeChatCandidate[]> {
  const workspacePath = resolve(workspace.localPath);
  const byID = new Map<string, NativeChatCandidate>();

  const externalProfiles = new Map(
    configuredAgentProfiles(workspacePath)
      .filter(
        (profile) =>
          profile.runtime === "claude" && profile.connectionType === "external",
      )
      .map((profile) => [
        resolve(externalConnectionDataHome(profile)),
        profile,
      ]),
  );
  for (const claudeHome of claudeHomeCandidates()) {
    const externalProfile = externalProfiles.get(resolve(claudeHome));
    const projectsRoot = resolve(claudeHome, "projects");
    const archivedRoot = resolve(claudeHome, "archived_sessions", "projects");
    const sessionPaths = (
      await Promise.all([
        jsonlFiles(projectsRoot, 2500, claudeSessionDepth),
        jsonlFiles(archivedRoot, 2500, claudeSessionDepth),
      ])
    ).flat();
    for (let index = 0; index < sessionPaths.length; index += 1) {
      const sessionPath = sessionPaths[index];
      if (!sessionPath) {
        continue;
      }
      const candidate = await cachedNativeChatCandidate(
        claudeNativeChatCache,
        sessionPath,
        parseClaudeSessionCandidate,
      );
      if (index % 4 === 3) {
        await yieldToEventLoop();
      }
      if (!candidate || candidate.workspacePath !== workspacePath) {
        continue;
      }
      const current = byID.get(candidate.id);
      if (!current || candidate.updatedAt > current.updatedAt) {
        byID.set(candidate.id, {
          ...candidate,
          ...(externalProfile
            ? {
                profileId: profileID(externalProfile),
                profileLabel: externalProfile.label,
                profileFingerprint: profileFingerprint(externalProfile),
              }
            : {}),
          archived: sessionPath.startsWith(archivedRoot + "/"),
        });
      }
    }
  }

  return [...byID.values()];
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolveYield) => setImmediate(resolveYield));
}

export function claudeHomeCandidates(): string[] {
  const candidates = [
    process.env.CLAUDE_CONFIG_DIR,
    ...externalConnectionDataHomes(),
    resolve(homedir(), ".claude"),
  ].filter((value): value is string => Boolean(value));
  return [...new Set(candidates.map((value) => resolve(value)))].filter(
    (value) => existsSync(value),
  );
}

export function codexHomeCandidates(): string[] {
  const candidates = [
    process.env.CODEX_HOME,
    resolve(homedir(), ".codex-personal"),
    resolve(homedir(), ".codex"),
  ].filter((value): value is string => Boolean(value));
  return [...new Set(candidates.map((value) => resolve(value)))].filter(
    (value) => existsSync(value),
  );
}

function codexSessionIndex(
  codexHome: string,
): Map<string, CodexSessionIndexEntry> {
  const index = new Map<string, CodexSessionIndexEntry>();
  const indexPath = resolve(codexHome, "session_index.jsonl");
  if (!existsSync(indexPath)) {
    return index;
  }
  for (const line of readFileSync(indexPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const record = JSON.parse(line) as CodexSessionIndexEntry;
      if (record.id) {
        index.set(record.id, record);
      }
    } catch {
      // Ignore malformed local index rows.
    }
  }
  return index;
}

// How deep session logs sit below their root: Claude keeps a session at
// projects/<project>/<id>.jsonl (deeper files are its subagents and tool
// results, not chats); Codex at sessions/<yyyy>/<mm>/<dd>/<file>.jsonl.
const claudeSessionDepth = 2;
const codexSessionDepth = 5;
// One listing serves every workspace synced in the same round.
const listingReuseMs = 5000;
export function invalidateNativeChatListings(): void {
  listings.clear();
}

const listings = new Map<string, { at: number; files: Promise<string[]> }>();

/**
 * The newest session logs under root, at most `depth` levels down. It walks
 * asynchronously and yields between directories, so a large history never
 * keeps the worker from answering the server.
 */
function jsonlFiles(
  root: string,
  limit: number,
  depth: number,
): Promise<string[]> {
  const key = `${root}\0${limit}\0${depth}`;
  const reused = listings.get(key);
  if (reused && Date.now() - reused.at < listingReuseMs) return reused.files;
  const files = walkJsonlFiles(root, limit, depth);
  listings.set(key, { at: Date.now(), files });
  void files.catch(() => listings.delete(key));
  return files;
}

async function walkJsonlFiles(
  root: string,
  limit: number,
  depth: number,
): Promise<string[]> {
  if (!existsSync(root)) {
    return [];
  }
  const files: { path: string; mtimeMs: number }[] = [];
  const stack: { dir: string; level: number }[] = [{ dir: root, level: 0 }];
  while (stack.length > 0) {
    const { dir, level } = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (level + 1 < depth) stack.push({ dir: entryPath, level: level + 1 });
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          files.push({
            path: entryPath,
            mtimeMs: (await stat(entryPath)).mtimeMs,
          });
        } catch {
          continue;
        }
      }
    }
    await yieldToEventLoop();
  }
  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((file) => file.path);
}

async function cachedNativeChatCandidate(
  cache: Map<string, NativeChatCacheEntry>,
  sessionPath: string,
  parse: (
    path: string,
    stat: Stats,
  ) => Promise<NativeChatCandidate | undefined>,
): Promise<NativeChatCandidate | undefined> {
  let stat: Stats;
  try {
    stat = statSync(sessionPath);
  } catch {
    cache.delete(sessionPath);
    return undefined;
  }
  const existing = cache.get(sessionPath);
  if (
    existing &&
    existing.mtimeMs === stat.mtimeMs &&
    existing.size === stat.size
  ) {
    return existing.value;
  }
  const value = parse(sessionPath, stat);
  const entry = { mtimeMs: stat.mtimeMs, size: stat.size, value };
  cache.set(sessionPath, entry);
  void value.catch(() => {
    if (cache.get(sessionPath) === entry) {
      cache.delete(sessionPath);
    }
  });
  return value;
}

async function readSessionPrefixLines(
  sessionPath: string,
  fileSize: number,
  byteLimit: number,
): Promise<string[]> {
  const byteLength = Math.min(fileSize, byteLimit);
  if (byteLength <= 0) {
    return [];
  }
  const file = await openFile(sessionPath, "r");
  try {
    const buffer = Buffer.allocUnsafe(byteLength);
    const { bytesRead } = await file.read(buffer, 0, byteLength, 0);
    let text = buffer.toString("utf8", 0, bytesRead);
    if (bytesRead < fileSize) {
      const finalNewline = text.lastIndexOf("\n");
      if (finalNewline >= 0) {
        text = text.slice(0, finalNewline);
      }
    }
    return text.split(/\r?\n/).filter(Boolean);
  } finally {
    await file.close();
  }
}

/** Complete lines of a log and the byte offset each starts at. */
interface LogWindow {
  lines: string[];
  offsets: number[];
  /** Where the first line starts: the next older window ends here. */
  start: number;
}

/**
 * The complete lines of a log that end at `end` (a line boundary, or the
 * log's size), about `byteLimit` bytes of them. A window always holds at
 * least the line ending at `end`, however long, unless it is longer than
 * nativeLogLineLimit: then the window is empty and starts where that line
 * does, so paging goes on past it.
 */
async function readLogWindow(
  sessionPath: string,
  end: number,
  byteLimit: number,
): Promise<LogWindow> {
  const file = await openFile(sessionPath, "r");
  try {
    let start = Math.max(0, end - byteLimit);
    if (start > 0) {
      const boundary = await lineStartFrom(file, start, end);
      start = boundary < end ? boundary : await lineStartBefore(file, end);
    }
    if (end - start > nativeLogLineLimit)
      return { lines: [], offsets: [], start };
    const buffer = Buffer.allocUnsafe(end - start);
    const { bytesRead } = await file.read(buffer, 0, end - start, start);
    const lines: string[] = [];
    const offsets: number[] = [];
    let from = 0;
    while (from < bytesRead) {
      const newline = buffer.indexOf(0x0a, from);
      const to = newline < 0 || newline >= bytesRead ? bytesRead : newline;
      const line = buffer.toString("utf8", from, to).replace(/\r$/, "");
      if (line) {
        lines.push(line);
        offsets.push(start + from);
      }
      from = to + 1;
    }
    return { lines, offsets, start };
  } finally {
    await file.close();
  }
}

const scanChunk = 64 * 1024;

/** The first line start at or after `position`, or `end` when none is. */
async function lineStartFrom(
  file: FileHandle,
  position: number,
  end: number,
): Promise<number> {
  const buffer = Buffer.allocUnsafe(scanChunk);
  // A line starts at `position` when the byte before it ends a line.
  for (let at = position - 1; at < end; at += scanChunk) {
    const length = Math.min(scanChunk, end - at);
    const { bytesRead } = await file.read(buffer, 0, length, at);
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (newline >= 0) return at + newline + 1;
    if (bytesRead < length) break;
  }
  return end;
}

/** Where the line that ends at `end` starts. */
async function lineStartBefore(file: FileHandle, end: number): Promise<number> {
  const buffer = Buffer.allocUnsafe(scanChunk);
  // The byte before `end` is that line's own newline.
  let to = end - 1;
  while (to > 0) {
    const at = Math.max(0, to - scanChunk);
    const { bytesRead } = await file.read(buffer, 0, to - at, at);
    const newline = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (newline >= 0) return at + newline + 1;
    to = at;
  }
  return 0;
}

async function parseCodexSessionCandidate(
  sessionPath: string,
  stat: Stats,
): Promise<NativeChatCandidate | undefined> {
  const lines = await readSessionPrefixLines(
    sessionPath,
    stat.size,
    nativeSessionHeaderByteLimit,
  );
  if (lines.length === 0) {
    return undefined;
  }

  const firstLine = lines[0];
  if (!firstLine) {
    return undefined;
  }
  const meta = parseJSONRecord(firstLine);
  if (
    meta?.type !== "session_meta" ||
    !meta.payload ||
    typeof meta.payload !== "object"
  ) {
    return undefined;
  }
  const payload = meta.payload as Record<string, unknown>;
  const cwd = typeof payload.cwd === "string" ? resolve(payload.cwd) : "";
  if (!cwd) {
    return undefined;
  }

  const id =
    typeof payload.session_id === "string"
      ? payload.session_id
      : typeof payload.id === "string"
        ? payload.id
        : "";
  if (!id) {
    return undefined;
  }

  const preview = codexSessionPreview(lines) || "Codex native session";
  const latest = await readShownWindow(
    sessionPath,
    stat.size,
    "codex",
    holdsTurn,
  );
  const { activityAt: tailActivity, ...recap } = nativeChatRecap(
    latest.lines,
    "codex",
    stat.mtime,
  );
  const activityAt = conversationActivity(tailActivity, lines, "codex");
  if (!activityAt) return undefined;
  return {
    handoffContext: codexSessionHandoffContext(lines),
    transcript: latest.transcript,
    ...(latest.start > 0 ? { transcriptBefore: latest.start } : {}),
    ...recap,
    id,
    preview,
    provider: "codex",
    title: preview || "Codex session",
    updatedAt: activityAt,
    workspacePath: cwd,
  };
}

async function parseClaudeSessionCandidate(
  sessionPath: string,
  stat: Stats,
): Promise<NativeChatCandidate | undefined> {
  const headerLines = await readSessionPrefixLines(
    sessionPath,
    stat.size,
    nativeSessionHeaderByteLimit,
  );
  let id = "";
  let workspacePath = "";

  for (const line of headerLines.slice(0, 200)) {
    const record = parseJSONRecord(line);
    if (!record) {
      continue;
    }
    const sessionID =
      typeof record.sessionId === "string" ? record.sessionId : "";
    if (sessionID) {
      id = sessionID;
    }
    const cwd = typeof record.cwd === "string" ? resolve(record.cwd) : "";
    if (cwd) {
      workspacePath = cwd;
    }
  }

  if (!id) {
    const filename = basename(sessionPath);
    id = filename.endsWith(".jsonl")
      ? filename.slice(0, -".jsonl".length)
      : filename;
  }
  if (!id || !workspacePath) {
    return undefined;
  }

  const lines = headerLines;
  const preview = claudeSessionPreview(lines) || "Claude native session";
  const latest = await readShownWindow(
    sessionPath,
    stat.size,
    "claude",
    holdsTurn,
  );
  const { activityAt: tailActivity, ...recap } = nativeChatRecap(
    latest.lines,
    "claude",
    stat.mtime,
  );
  const activityAt = conversationActivity(tailActivity, lines, "claude");
  if (!activityAt) return undefined;
  return {
    handoffContext: claudeSessionHandoffContext(lines),
    transcript: latest.transcript,
    ...(latest.start > 0 ? { transcriptBefore: latest.start } : {}),
    ...recap,
    id,
    preview,
    provider: "claude",
    title: preview || "Claude session",
    updatedAt: activityAt,
    workspacePath,
  };
}
