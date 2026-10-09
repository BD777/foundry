// Native chat session parsing: reads Codex/Claude conversation logs from the
// local filesystem and projects them as Foundry chat threads. Self-contained
// except for protocol types and node built-ins.

import { existsSync, readFileSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { open as openFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { nativeChatTranscript } from "./native-chat-transcript.js";
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

/** Lightweight answer identity and the latest two exchanges, not the log prefix. */
function clipNativeRecapText(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= 1024) return text;
  const characters = Array.from(text);
  return `${characters.slice(0, 160).join("")}\n…\n${characters.slice(-80).join("")}`;
}

/**
 * A native turn only runs while its agent writes its session file. A turn
 * that started and then went silent this long was cut off (the process was
 * killed or the machine restarted) and never wrote its end.
 */
const nativeTurnSilenceMs = 30 * 60 * 1000;

/**
 * Records that are the conversation itself. Claude Code appends bookkeeping
 * (last-prompt, ai-title, cost-state, …) when an idle session closes; those
 * are not activity.
 */
function conversationRecord(
  record: Record<string, unknown> | undefined,
  provider: "codex" | "claude",
): boolean {
  return provider === "claude"
    ? record?.type === "user" || record?.type === "assistant"
    : record?.type === "response_item" || record?.type === "event_msg";
}

/**
 * When a native session's conversation last moved, from its records, never
 * the file's write time: idle sessions and `/resume` rewrite files without a
 * new turn. A file without any conversation (a `/resume` stub) is not a chat.
 */
function conversationActivity(
  tailActivity: Date | undefined,
  headLines: string[],
  provider: "codex" | "claude",
): Date | undefined {
  return tailActivity ?? nativeChatRecap(headLines, provider).activityAt;
}

export function nativeChatRecap(
  lines: string[],
  provider: "codex" | "claude",
  lastWrite?: Date,
): Pick<ChatThread, "answerRevision" | "recentMessages" | "status"> & {
  /** When the conversation last moved: its latest message or step. */
  activityAt?: Date;
} {
  const messages: NonNullable<ChatThread["recentMessages"]> = [];
  let answerRevision: string | undefined;
  let status: ChatThread["status"];
  let activityAt: Date | undefined;
  for (const line of lines) {
    const record = parseJSONRecord(line);
    if (
      conversationRecord(record, provider) &&
      typeof record?.timestamp === "string"
    ) {
      const at = new Date(record.timestamp);
      if (Number.isFinite(at.getTime()) && (!activityAt || at > activityAt))
        activityAt = at;
    }
    const payload =
      record?.payload && typeof record.payload === "object"
        ? (record.payload as Record<string, unknown>)
        : undefined;
    if (provider === "codex" && record?.type === "event_msg") {
      if (payload?.type === "task_started") status = "running";
      else if (payload?.type === "task_complete") status = "completed";
      else if (payload?.type === "turn_aborted") status = "canceled";
      else if (payload?.type === "error") status = "failed";
    }
    if (record?.type === "result")
      status = record.is_error ? "failed" : "completed";
    if (record?.isApiErrorMessage === true) status = "failed";
    const user = cleanSessionUserMessage(
      provider === "codex"
        ? eventUserMessage(record) || responseItemUserMessage(record)
        : claudeUserMessage(record),
    );
    const assistant =
      provider === "codex"
        ? responseItemAssistantMessage(record) || eventAssistantMessage(record)
        : claudeAssistantMessage(record);
    const text = user || assistant;
    if (!text) continue;
    const role = user ? "user" : "assistant";
    if (assistant)
      answerRevision = createHash("sha256").update(line).digest("hex");
    const previous = messages.at(-1);
    const clipped = clipNativeRecapText(text);
    if (previous?.role === role && previous.text === clipped) continue;
    if (previous?.role === "assistant" && role === "assistant") {
      const combined = previous.text + "\n\n" + clipped;
      previous.text = clipNativeRecapText(combined);
    } else messages.push({ role, text: clipped });
    while (messages.filter((message) => message.role === "user").length > 2)
      messages.shift();
  }
  if (
    status === "running" &&
    lastWrite &&
    Date.now() - lastWrite.getTime() > nativeTurnSilenceMs
  )
    status = "canceled";
  let start = messages.length;
  let users = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    start = index;
    if (messages[index]?.role === "user" && ++users === 2) break;
  }
  return {
    activityAt,
    answerRevision,
    recentMessages: messages.slice(start).slice(-8),
    status,
  };
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

function codexSessionPreview(lines: string[]): string {
  for (const line of lines.slice(1, 80)) {
    const record = parseJSONRecord(line);
    const message = eventUserMessage(record) || responseItemUserMessage(record);
    const preview = firstUserAuthoredLine(cleanSessionUserMessage(message));
    if (preview) {
      return preview;
    }
  }
  return "";
}

function claudeSessionPreview(lines: string[]): string {
  for (const line of lines.slice(0, 120)) {
    const record = parseJSONRecord(line);
    const message = claudeUserMessage(record);
    const preview = firstUserAuthoredLine(cleanSessionUserMessage(message));
    if (preview) {
      return preview;
    }
  }
  return "";
}

function codexSessionHandoffContext(lines: string[]): string {
  const turns: string[] = [];
  for (const line of lines.slice(1)) {
    const record = parseJSONRecord(line);
    const user = cleanSessionUserMessage(
      eventUserMessage(record) || responseItemUserMessage(record),
    );
    if (user) {
      pushHandoffTurn(turns, `User: ${user}`);
      continue;
    }
    const assistant =
      responseItemAssistantMessage(record) || eventAssistantMessage(record);
    if (assistant) {
      pushHandoffTurn(turns, `Codex: ${assistant}`);
    }
    if (turns.join("\n\n").length > 12000) {
      break;
    }
  }
  return truncateHandoffContext(turns.join("\n\n"));
}

function claudeSessionHandoffContext(lines: string[]): string {
  const turns: string[] = [];
  for (const line of lines) {
    const record = parseJSONRecord(line);
    const user = cleanSessionUserMessage(claudeUserMessage(record));
    if (user) {
      pushHandoffTurn(turns, `User: ${user}`);
      continue;
    }
    const assistant = claudeAssistantMessage(record);
    if (assistant) {
      pushHandoffTurn(turns, `Claude: ${assistant}`);
    }
    if (turns.join("\n\n").length > 12000) {
      break;
    }
  }
  return truncateHandoffContext(turns.join("\n\n"));
}

function pushHandoffTurn(turns: string[], turn: string): void {
  const normalized = turn.trim();
  if (!normalized || turns[turns.length - 1] === normalized) {
    return;
  }
  turns.push(normalized);
}

function truncateHandoffContext(value: string): string {
  const limit = 12000;
  const prefix = "Earlier context truncated.\n\n";
  const text = value.trim();
  if (text.length <= limit) {
    return text;
  }
  return `${prefix}${text.slice(-(limit - prefix.length))}`;
}

function cleanSessionUserMessage(message: string): string {
  const kept: string[] = [];
  for (const line of message.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (kept.length > 0 && kept[kept.length - 1] !== "") {
        kept.push("");
      }
      continue;
    }
    if (
      isInjectedContextLine(trimmed) ||
      isFoundryRuntimeInstructionLine(trimmed)
    ) {
      break;
    }
    kept.push(line);
  }
  return kept.join("\n").trim();
}

function firstUserAuthoredLine(message: string): string {
  const lines = message.split(/\r?\n/);
  const firstMeaningful =
    lines.find((line) => line.trim() !== "")?.trim() ?? "";
  if (!firstMeaningful || isInjectedContextLine(firstMeaningful)) {
    return "";
  }
  return firstMeaningful.slice(0, 96);
}

function isInjectedContextLine(line: string): boolean {
  return (
    line.startsWith("<recommended_plugins>") ||
    line.startsWith("<environment_context>") ||
    line.startsWith("<apps_instructions>") ||
    line.startsWith("<plugins_instructions>") ||
    line.startsWith("<skills_instructions>") ||
    line.startsWith("<permissions instructions>") ||
    line.startsWith("<collaboration_mode>") ||
    line.startsWith("<INSTRUCTIONS>") ||
    line.startsWith("# AGENTS.md instructions") ||
    line.startsWith("# Personal Codex Profile")
  );
}

function isFoundryRuntimeInstructionLine(line: string): boolean {
  return line.startsWith("You are running through Foundry's local daemon");
}

function parseJSONRecord(line: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function eventUserMessage(record: Record<string, unknown> | undefined): string {
  if (
    record?.type !== "event_msg" ||
    !record.payload ||
    typeof record.payload !== "object"
  ) {
    return "";
  }
  const payload = record.payload as Record<string, unknown>;
  return payload.type === "user_message" && typeof payload.message === "string"
    ? payload.message
    : "";
}

function responseItemUserMessage(
  record: Record<string, unknown> | undefined,
): string {
  if (
    record?.type !== "response_item" ||
    !record.payload ||
    typeof record.payload !== "object"
  ) {
    return "";
  }
  const payload = record.payload as Record<string, unknown>;
  if (payload.role !== "user" || !Array.isArray(payload.content)) {
    return "";
  }
  const parts = payload.content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }
      const content = item as Record<string, unknown>;
      return typeof content.text === "string" ? content.text : "";
    })
    .filter(Boolean);
  return parts.join("\n\n");
}

function responseItemAssistantMessage(
  record: Record<string, unknown> | undefined,
): string {
  if (
    record?.type !== "response_item" ||
    !record.payload ||
    typeof record.payload !== "object"
  ) {
    return "";
  }
  const payload = record.payload as Record<string, unknown>;
  if (payload.role !== "assistant" || !Array.isArray(payload.content)) {
    return "";
  }
  return messageContentText(payload.content);
}

function eventAssistantMessage(
  record: Record<string, unknown> | undefined,
): string {
  if (
    record?.type !== "event_msg" ||
    !record.payload ||
    typeof record.payload !== "object"
  ) {
    return "";
  }
  const payload = record.payload as Record<string, unknown>;
  return payload.type === "agent_message" && typeof payload.message === "string"
    ? payload.message.trim()
    : "";
}

function claudeUserMessage(
  record: Record<string, unknown> | undefined,
): string {
  if (
    record?.type !== "user" ||
    !record.message ||
    typeof record.message !== "object"
  ) {
    return "";
  }
  const message = record.message as Record<string, unknown>;
  if (message.role !== "user") {
    return "";
  }
  return messageContentText(message.content);
}

function claudeAssistantMessage(
  record: Record<string, unknown> | undefined,
): string {
  if (
    record?.type !== "assistant" ||
    !record.message ||
    typeof record.message !== "object"
  ) {
    return "";
  }
  const message = record.message as Record<string, unknown>;
  if (message.role !== "assistant") {
    return "";
  }
  return messageContentText(message.content);
}

function messageContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const value = part as Record<string, unknown>;
      return typeof value.text === "string" ? value.text : "";
    })
    .filter(Boolean)
    .join("\n\n");
}
