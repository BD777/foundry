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
  WorkerRuntimeId,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";

interface CodexSessionIndexEntry {
  id: string;
  thread_name?: string;
  updated_at?: string;
}

interface NativeChatCandidate {
  id: string;
  profileFingerprint?: string;
  profileId?: string;
  profileLabel?: string;
  provider: Exclude<WorkerRuntimeId, "mock">;
  title: string;
  preview: string;
  handoffContext?: string;
  transcript?: ChatThread["transcript"];
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
const nativeSessionTranscriptByteLimit = 1024 * 1024;

export async function nativeChatThreadsForWorkspace(
  workspace: WorkspaceProjection,
  profiles: AgentProfileProjection[],
  limit = 60,
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
    .slice(0, limit)
    .map((candidate) => {
      const profile = nativeProfiles.get(candidate.provider);
      return {
        id: `native_${candidate.provider}_${candidate.id}`,
        handoffContext: candidate.handoffContext,
        transcript: candidate.transcript,
        answerRevision: candidate.answerRevision,
        recentMessages: candidate.recentMessages,
        status: candidate.status,
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
    const sessionPaths = await jsonlFiles(
      sessionsRoot,
      2500,
      codexSessionDepth,
    );
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

  for (const claudeHome of claudeHomeCandidates()) {
    const projectsRoot = resolve(claudeHome, "projects");
    const sessionPaths = await jsonlFiles(
      projectsRoot,
      2500,
      claudeSessionDepth,
    );
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
        byID.set(candidate.id, candidate);
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

async function readSessionTailLines(
  sessionPath: string,
  fileSize: number,
): Promise<string[]> {
  const length = Math.min(fileSize, nativeSessionTranscriptByteLimit);
  const start = fileSize - length;
  const file = await openFile(sessionPath, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await file.read(buffer, 0, length, start);
    const lines = buffer.toString("utf8", 0, bytesRead).split(/\r?\n/);
    if (start > 0) lines.shift();
    return lines.filter(Boolean);
  } finally {
    await file.close();
  }
}

async function parseCodexSessionCandidate(
  sessionPath: string,
  stat: Stats,
): Promise<NativeChatCandidate | undefined> {
  const headerLines = await readSessionPrefixLines(
    sessionPath,
    stat.size,
    nativeSessionHeaderByteLimit,
  );
  const lines =
    stat.size > nativeSessionHeaderByteLimit
      ? await readSessionPrefixLines(
          sessionPath,
          stat.size,
          nativeSessionTranscriptByteLimit,
        )
      : headerLines;
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
  const { activityAt: tailActivity, ...recap } = nativeChatRecap(
    stat.size <= nativeSessionTranscriptByteLimit
      ? lines
      : await readSessionTailLines(sessionPath, stat.size),
    "codex",
    stat.mtime,
  );
  const activityAt = conversationActivity(tailActivity, lines, "codex");
  if (!activityAt) return undefined;
  return {
    handoffContext: codexSessionHandoffContext(lines),
    transcript: nativeChatTranscript(
      lines,
      "codex",
      stat.size > nativeSessionTranscriptByteLimit,
    ),
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

  const lines =
    stat.size > nativeSessionHeaderByteLimit
      ? await readSessionPrefixLines(
          sessionPath,
          stat.size,
          nativeSessionTranscriptByteLimit,
        )
      : headerLines;
  const preview = claudeSessionPreview(lines) || "Claude native session";
  const { activityAt: tailActivity, ...recap } = nativeChatRecap(
    stat.size <= nativeSessionTranscriptByteLimit
      ? lines
      : await readSessionTailLines(sessionPath, stat.size),
    "claude",
    stat.mtime,
  );
  const activityAt = conversationActivity(tailActivity, lines, "claude");
  if (!activityAt) return undefined;
  return {
    handoffContext: claudeSessionHandoffContext(lines),
    transcript: nativeChatTranscript(
      lines,
      "claude",
      stat.size > nativeSessionTranscriptByteLimit,
    ),
    ...recap,
    id,
    preview,
    provider: "claude",
    title: preview || "Claude session",
    updatedAt: activityAt,
    workspacePath,
  };
}
