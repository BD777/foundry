// The files a session's own tools wrote and its answers named: a ledger per
// session under the sessions root, so they stay readable after a restart.
//
// Attribution comes only from the agent's successful write-tool calls (main
// thread and subagents, inside the workspace or not). Files that merely
// changed on disk while the agent ran are never credited to it: another
// agent, an editor or a build may have changed them.

import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { SessionToolFrames } from "./tool-frames.js";
import { homedir } from "node:os";
import {
  dirname,
  extname,
  isAbsolute,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  processLabels,
  type AgentSession,
  type SessionFileDiff,
  type SessionFileDiffAvailability,
  type SessionFileRead,
  type SessionFileRecord,
  type SessionFileReference,
  type FileDownloadRequest,
} from "@bd777/foundry-protocol";
import type { SessionEventEmitter } from "./session-state.js";
import {
  currentFile,
  lineChangeCounts,
  maxBaselineBytes,
  sameSnapshot,
  sessionFileChange,
  TurnFileChanges,
  turnDirectory,
  type SessionFileChange,
} from "./session-file-diffs.js";
import { within } from "./paths.js";
import { writePrivateJSONAtomic } from "./storage.js";
import {
  privateDevicePath,
  resolveFileReferences,
  workspaceAttachmentPath,
} from "./session-file-references.js";
import { errorMessage } from "./utils.js";
import { readFileDownloadChunk } from "./file-downloads.js";

/** One file in a session's ledger. */
export interface SessionFileEntry {
  /** Absolute path as the tool or answer named it. */
  path: string;
  workspacePath?: string;
  origin: "tool" | "reference";
  op: SessionFileRecord["op"];
  inGitRepo: boolean;
  /** Inputs whose turns wrote or named it, oldest first. */
  inputIds: string[];
  /** "main", or the subagent whose tool wrote it. */
  agent: string;
  /** Where the path resolved when it was recorded; reads must still match. */
  realpath: string;
  bytes?: number;
  /** Modification time when its last turn ended. */
  mtimeMs?: number;
  /**
   * An answer named it before it existed. Not reported as a session file
   * until a write tool records it or an answer names it once it exists;
   * reads serve it once it appears where it was expected to resolve.
   */
  pending?: true;
}

interface SessionFileLedger {
  version: 1;
  files: SessionFileEntry[];
}

/** A write tool's successful change to one file. */
export interface ToolFileWrite {
  path: string;
  op: "created" | "modified" | "deleted";
  agent: string;
}

/** The session's own folder under the sessions root; refuses escapes. */
export function sessionDirectory(
  sessionsRoot: string,
  sessionId: string,
): string {
  const directory = resolve(sessionsRoot, sessionId);
  const relativePath = relative(sessionsRoot, directory);
  if (
    !sessionId.trim() ||
    !relativePath ||
    relativePath.startsWith("..") ||
    isAbsolute(relativePath) ||
    relativePath.includes(sep)
  )
    throw new Error("invalid session id");
  return directory;
}

export function sessionFileLedgerPath(
  sessionsRoot: string,
  sessionId: string,
): string {
  return resolve(sessionDirectory(sessionsRoot, sessionId), "files.json");
}

export function readSessionFileLedger(
  sessionsRoot: string,
  sessionId: string,
): SessionFileEntry[] {
  const path = sessionFileLedgerPath(sessionsRoot, sessionId);
  if (!existsSync(path)) return [];
  const value = JSON.parse(readFileSync(path, "utf8")) as SessionFileLedger;
  return Array.isArray(value.files) ? value.files : [];
}

function writeSessionFileLedger(
  sessionsRoot: string,
  sessionId: string,
  files: SessionFileEntry[],
): void {
  writePrivateJSONAtomic(sessionFileLedgerPath(sessionsRoot, sessionId), {
    version: 1,
    files,
  } satisfies SessionFileLedger);
}

/** Inside a Git work tree: a `.git` in the folder or one of its parents. */
export function insideGitWorkTree(path: string): boolean {
  let folder = dirname(path);
  while (true) {
    if (existsSync(resolve(folder, ".git"))) return true;
    const parent = dirname(folder);
    if (parent === folder) return false;
    folder = parent;
  }
}

function stats(
  path: string,
): { bytes: number; mtimeMs: number; realpath: string } | undefined {
  try {
    const stat = statSync(path);
    return stat.isFile()
      ? {
          bytes: stat.size,
          mtimeMs: stat.mtimeMs,
          realpath: realpathSync(path),
        }
      : undefined;
  } catch {
    return undefined;
  }
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The op a later write leaves: a file this session created stays created. */
function mergedOp(
  earlier: SessionFileEntry["op"],
  later: SessionFileEntry["op"],
): SessionFileEntry["op"] {
  if (later === "referenced") return earlier;
  if (later === "deleted" || earlier === "referenced") return later;
  return earlier === "created" ? "created" : later;
}

/**
 * Records one turn's files: each successful tool write as it happens, and
 * at the end the paths the answer names. Each file is reported once per
 * turn as a `sessionFile` event.
 */
export class SessionTurnFiles {
  private readonly reported = new Map<string, SessionFileRecord>();
  private readonly workspaceRealpath: string;
  /** Copies of the files before and after the session's writes. */
  private readonly changes: TurnFileChanges;
  /** Writes are recorded in order, off the tool call's path. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: {
      workspacePath: string;
      sessionsRoot: string;
      sessionId: string;
      inputId?: string;
      emit: SessionEventEmitter;
      /** Epoch ms the turn began; files only named must be newer. */
      startedAt: number;
      home?: string;
    },
  ) {
    this.workspaceRealpath = realpathOrSelf(options.workspacePath);
    this.changes = new TurnFileChanges(
      turnDirectory(options.sessionsRoot, options.sessionId, options.inputId),
    );
  }

  private toolFrames?: SessionToolFrames;

  /** Screenshots the session's tools returned, stored as its frames (DEV-075). */
  frames(): SessionToolFrames {
    this.toolFrames ??= new SessionToolFrames({
      workspacePath: this.options.workspacePath,
      sessionId: this.options.sessionId,
      inputId: this.options.inputId,
    });
    return this.toolFrames;
  }

  /** The directory the session's tools run in. */
  get workspacePath(): string {
    return this.options.workspacePath;
  }

  static forSession(
    workspacePath: string,
    sessionsRoot: string,
    session: AgentSession,
    emit: SessionEventEmitter,
    startedAt = Date.now(),
  ): SessionTurnFiles {
    return new SessionTurnFiles({
      workspacePath,
      sessionsRoot,
      sessionId: session.id,
      inputId: session.input?.id,
      emit,
      startedAt,
    });
  }

  private ledger(): SessionFileEntry[] {
    try {
      return readSessionFileLedger(
        this.options.sessionsRoot,
        this.options.sessionId,
      );
    } catch {
      return [];
    }
  }

  private save(files: SessionFileEntry[]): void {
    writeSessionFileLedger(
      this.options.sessionsRoot,
      this.options.sessionId,
      files,
    );
  }

  private workspaceRelative(
    path: string,
    realpath: string,
  ): string | undefined {
    for (const [root, target] of [
      [this.options.workspacePath, path],
      [this.workspaceRealpath, realpath],
    ] as const) {
      if (within(root, target)) {
        const relativePath = relative(root, target);
        if (relativePath) return relativePath;
      }
    }
    return undefined;
  }

  private upsert(
    files: SessionFileEntry[],
    entry: Omit<SessionFileEntry, "inputIds">,
  ): SessionFileEntry {
    const inputId = this.options.inputId;
    const existing = files.find(
      (file) => file.path === entry.path || file.realpath === entry.realpath,
    );
    if (!existing) {
      const created = { ...entry, inputIds: inputId ? [inputId] : [] };
      files.push(created);
      return created;
    }
    existing.op = mergedOp(existing.op, entry.op);
    if (!entry.pending) delete existing.pending;
    if (entry.origin === "tool") {
      existing.origin = "tool";
      existing.agent = entry.agent;
    }
    existing.realpath = entry.realpath;
    existing.bytes = entry.bytes ?? existing.bytes;
    existing.mtimeMs = entry.mtimeMs ?? existing.mtimeMs;
    existing.inGitRepo = entry.inGitRepo;
    existing.workspacePath = entry.workspacePath;
    if (inputId && !existing.inputIds.includes(inputId))
      existing.inputIds.push(inputId);
    return existing;
  }

  private async report(
    entry: SessionFileEntry,
    op: SessionFileRecord["op"],
    counts?: Pick<
      SessionFileRecord,
      "added" | "removed" | "totalAdded" | "totalRemoved" | "diff" | "totalDiff"
    >,
  ): Promise<void> {
    const reported = this.reported.get(entry.path);
    const record: SessionFileRecord = {
      path: entry.path,
      ...(entry.workspacePath ? { workspacePath: entry.workspacePath } : {}),
      origin: entry.origin,
      op: reported ? mergedOp(reported.op, op) : op,
      inGitRepo: entry.inGitRepo,
      ...(this.options.inputId ? { inputId: this.options.inputId } : {}),
      agent: entry.agent,
      ...(entry.bytes !== undefined ? { bytes: entry.bytes } : {}),
      ...counts,
    };
    if (
      reported &&
      reported.op === record.op &&
      reported.origin === record.origin &&
      reported.added === record.added &&
      reported.removed === record.removed &&
      reported.totalAdded === record.totalAdded &&
      reported.totalRemoved === record.totalRemoved &&
      reported.diff === record.diff &&
      reported.totalDiff === record.totalDiff
    )
      return;
    this.reported.set(entry.path, record);
    await this.options.emit(
      processLabels.recordedFile,
      entry.workspacePath ?? entry.path,
      "info",
      { sessionFile: record },
    );
  }

  /**
   * A write tool is about to run: keep the file as the session found it, the
   * first time in the turn. The tool waits for this.
   */
  captureBeforeWrite(write: Pick<ToolFileWrite, "path">): Promise<void> {
    this.queue = this.queue
      .then(() => {
        const path = this.absolute(write.path);
        if (this.privatePath(path, realpathOrSelf(path))) return;
        this.changes.captureBefore(path);
      })
      .catch((error: unknown) =>
        console.error(
          `Could not keep a copy of ${write.path}: ${errorMessage(error)}`,
        ),
      );
    return this.queue;
  }

  /**
   * Codex: snapshots the workspace's Git work tree before the turn runs, so
   * its diffs have a "before". Outside a Git work tree there is none.
   */
  async snapshotWorkTree(): Promise<void> {
    await this.changes.snapshotGitWorkTree(
      this.options.workspacePath,
      sessionDirectory(this.options.sessionsRoot, this.options.sessionId),
    );
  }

  private absolute(path: string): string {
    return isAbsolute(path)
      ? resolve(path)
      : resolve(this.options.workspacePath, path);
  }

  private privatePath(path: string, realpath: string): boolean {
    const home = this.options.home ?? homedir();
    return (
      privateDevicePath(path, home, this.options.workspacePath) ||
      privateDevicePath(realpath, home, this.workspaceRealpath)
    );
  }

  /**
   * Listed under Changes: inside a Git work tree, but not the workspace's
   * attachments, which are Foundry's and never part of the work tree.
   */
  private inGitRepo(path: string, realpath: string): boolean {
    return (
      !workspaceAttachmentPath(path, this.options.workspacePath) &&
      !workspaceAttachmentPath(realpath, this.workspaceRealpath) &&
      insideGitWorkTree(realpath)
    );
  }

  /** A write tool reported success for this file. */
  recordToolWrite(write: ToolFileWrite): Promise<void> {
    this.queue = this.queue
      .then(() => this.recordWrite(write))
      .catch((error: unknown) =>
        console.error(`Could not record ${write.path}: ${errorMessage(error)}`),
      );
    return this.queue;
  }

  private async recordWrite(write: ToolFileWrite): Promise<void> {
    const path = this.absolute(write.path);
    const found = write.op === "deleted" ? undefined : stats(path);
    const realpath = found?.realpath ?? realpathOrSelf(path);
    if (this.privatePath(path, realpath)) return;
    this.changes.captureAfter(path);
    const files = this.ledger();
    const entry = this.upsert(files, {
      path,
      workspacePath: this.workspaceRelative(path, realpath),
      origin: "tool",
      op: write.op,
      inGitRepo: this.inGitRepo(path, realpath),
      agent: write.agent,
      realpath,
      ...(found ? { bytes: found.bytes, mtimeMs: found.mtimeMs } : {}),
    });
    this.save(files);
    await this.report(entry, write.op);
  }

  /**
   * The turn's and the session's line counts for each file it wrote, and
   * whether each has a text diff, so a reader knows before asking.
   */
  private async reportLineCounts(files: SessionFileEntry[]): Promise<void> {
    try {
      this.changes.pruneCopies();
    } catch {
      // Copies left behind only cost space.
    }
    for (const [path, record] of this.reported) {
      if (record.origin !== "tool") continue;
      const entry = files.find((file) => file.path === path);
      if (!entry) continue;
      try {
        const turnChange = await sessionFileChange(
          this.options.sessionsRoot,
          this.options.sessionId,
          path,
          this.options.inputId,
        );
        const totalChange = this.options.inputId
          ? await sessionFileChange(
              this.options.sessionsRoot,
              this.options.sessionId,
              path,
            )
          : turnChange;
        const turn = changeCounts(turnChange);
        const total = changeCounts(totalChange);
        // Only changes (files in a Git work tree) offer a diff to open.
        if (!turn && !entry.inGitRepo) continue;
        await this.report(entry, record.op, {
          ...(turn ? { added: turn.added, removed: turn.removed } : {}),
          ...(total
            ? { totalAdded: total.added, totalRemoved: total.removed }
            : {}),
          ...(entry.inGitRepo
            ? {
                diff: diffAvailability(turnChange),
                totalDiff: diffAvailability(totalChange),
              }
            : {}),
        });
      } catch (error) {
        console.error(
          `Could not count the changes to ${path}: ${errorMessage(error)}`,
        );
      }
    }
  }

  /**
   * Ends the turn: records the files its answer names and returns the ones
   * the answer can link. A text naming two different files links neither.
   * A file named before it exists is kept as pending, linked but not
   * reported, so a read finds it once it is written.
   */
  async finish(answer: string): Promise<SessionFileReference[]> {
    await this.queue;
    const files = this.ledger();
    const resolved = resolveFileReferences({
      answer,
      workspacePath: this.options.workspacePath,
      recorded: files,
      turnStartedAt: this.options.startedAt,
      home: this.options.home,
    });
    const named: SessionFileEntry[] = [];
    let pending = false;
    for (const reference of resolved) {
      if (reference.kind !== "file") continue;
      const entry = this.upsert(files, {
        path: reference.path,
        workspacePath: this.workspaceRelative(
          reference.path,
          reference.realpath,
        ),
        origin: "reference",
        op: "referenced",
        inGitRepo: this.inGitRepo(reference.path, reference.realpath),
        agent: "main",
        realpath: reference.realpath,
        bytes: reference.bytes,
        mtimeMs: reference.mtimeMs,
        ...(reference.pending ? { pending: true as const } : {}),
      });
      if (reference.pending) pending = true;
      else named.push(entry);
    }
    // "Changed on device since this turn" compares with the turn's end.
    for (const entry of files) {
      if (!this.reported.has(entry.path) || entry.op === "deleted") continue;
      const found = stats(entry.path);
      if (found) {
        entry.bytes = found.bytes;
        entry.mtimeMs = found.mtimeMs;
      }
    }
    if (named.length > 0 || pending || this.reported.size > 0) this.save(files);
    for (const entry of named) await this.report(entry, "referenced");
    await this.reportLineCounts(files);

    const pathsByText = new Map<string, Set<string>>();
    for (const reference of resolved) {
      if (!reference.linkable) continue;
      const paths = pathsByText.get(reference.text) ?? new Set<string>();
      paths.add(reference.path);
      pathsByText.set(reference.text, paths);
    }
    const references: SessionFileReference[] = [];
    for (const reference of resolved) {
      if (
        !reference.linkable ||
        pathsByText.get(reference.text)!.size !== 1 ||
        references.some((known) => known.text === reference.text)
      )
        continue;
      references.push({
        text: reference.text,
        path: reference.path,
        kind: reference.kind,
        ...(reference.pending ? { pending: true } : {}),
      });
    }
    return references;
  }
}

/** Lines added and removed between a change's two sides, when both are text. */
function changeCounts(
  change: SessionFileChange | undefined,
): { added: number; removed: number } | undefined {
  if (!change?.after || diffAvailability(change) !== "text") return undefined;
  return lineChangeCounts(change.before.text!, change.after.text!);
}

/** Whether a change has a text diff; `after` stands in for a missing side. */
export function diffAvailability(
  change: SessionFileChange | undefined,
  after = change?.after,
): SessionFileDiffAvailability {
  if (!change || !after) return "noBaseline";
  if (
    change.before.snapshot.kind === "binary" ||
    after.snapshot.kind === "binary"
  )
    return "binary";
  if (
    change.before.snapshot.kind === "tooLarge" ||
    after.snapshot.kind === "tooLarge"
  )
    return "tooLarge";
  if (change.before.text === undefined || after.text === undefined)
    return "noBaseline";
  return change.before.text.length + after.text.length > maxBaselineBytes
    ? "tooLarge"
    : "text";
}

/** The file a Claude PostToolUse hook reports a write tool changed. */
export function claudeToolFileWrite(input: unknown): ToolFileWrite | undefined {
  if (!input || typeof input !== "object") return undefined;
  const hook = input as Record<string, unknown>;
  const tool = typeof hook.tool_name === "string" ? hook.tool_name : "";
  if (!claudeWriteTools.has(tool)) return undefined;
  const toolInput = (hook.tool_input ?? {}) as Record<string, unknown>;
  const path = [toolInput.file_path, toolInput.notebook_path].find(
    (value): value is string =>
      typeof value === "string" && value.trim() !== "",
  );
  if (!path) return undefined;
  const response = hook.tool_response;
  const responseType =
    response && typeof response === "object"
      ? (response as Record<string, unknown>).type
      : undefined;
  return {
    path: path.trim(),
    op: responseType === "create" ? "created" : "modified",
    agent:
      typeof hook.agent_id === "string" && hook.agent_id
        ? hook.agent_id
        : "main",
  };
}

const claudeWriteTools = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
]);

/**
 * Claude SDK hooks that record each successful write-tool call, the main
 * thread's and every subagent's. PostToolUse fires only after a tool
 * succeeded; a failed write reaches PostToolUseFailure instead.
 */
export function claudeFileWriteHooks(
  record: (write: ToolFileWrite) => Promise<void> | void,
  captureBefore?: (write: ToolFileWrite) => Promise<void> | void,
): Record<string, unknown[]> {
  return {
    ...(captureBefore
      ? {
          // The tool waits until the file's "before" copy is kept.
          PreToolUse: [
            {
              matcher: [...claudeWriteTools].join("|"),
              hooks: [
                async (input: unknown) => {
                  const write = claudeToolFileWrite(input);
                  if (write) await captureBefore(write);
                  return {};
                },
              ],
            },
          ],
        }
      : {}),
    PostToolUse: [
      {
        matcher: [...claudeWriteTools].join("|"),
        hooks: [
          async (input: unknown) => {
            const write = claudeToolFileWrite(input);
            // Recorded in the background: the tool call does not wait.
            if (write) void record(write);
            return {};
          },
        ],
      },
    ],
  };
}

/** Joins SDK hook maps: each event keeps every source's matchers. */
export function mergeClaudeHooks(
  ...sources: Array<Record<string, unknown>>
): Record<string, unknown[]> {
  const merged: Record<string, unknown[]> = {};
  for (const source of sources)
    for (const [event, matchers] of Object.entries(source))
      merged[event] = [
        ...(merged[event] ?? []),
        ...(Array.isArray(matchers) ? matchers : []),
      ];
  return merged;
}

/** Files a Codex patch changed, once the item completed successfully. */
export function codexFileWrites(event: unknown): ToolFileWrite[] {
  if (!event || typeof event !== "object") return [];
  const record = event as Record<string, unknown>;
  const item = record.item as Record<string, unknown> | undefined;
  if (
    record.type !== "item.completed" ||
    !item ||
    item.type !== "file_change" ||
    item.status !== "completed" ||
    !Array.isArray(item.changes)
  )
    return [];
  return item.changes.flatMap((change: unknown): ToolFileWrite[] => {
    if (!change || typeof change !== "object") return [];
    const { path, kind } = change as Record<string, unknown>;
    if (typeof path !== "string" || !path.trim()) return [];
    return [
      {
        path: path.trim(),
        op:
          kind === "add"
            ? "created"
            : kind === "delete"
              ? "deleted"
              : "modified",
        agent: "main",
      },
    ];
  });
}

/** Bytes of a file a read returns, at most. */
const maxTextBytes = 256 * 1024;
/** Images up to this size are returned for inline preview. */
const maxImageBytes = 2 * 1024 * 1024;

const imageTypes: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

const binaryExtensions = new Set(
  [
    "7z",
    "a",
    "avi",
    "bin",
    "bmp",
    "class",
    "db",
    "dll",
    "doc",
    "docx",
    "dylib",
    "eot",
    "exe",
    "gz",
    "ico",
    "jar",
    "mkv",
    "mov",
    "mp3",
    "mp4",
    "o",
    "otf",
    "pdf",
    "ppt",
    "pptx",
    "psd",
    "pyc",
    "so",
    "sqlite",
    "tar",
    "tgz",
    "tif",
    "tiff",
    "ttf",
    "wasm",
    "wav",
    "webm",
    "woff",
    "woff2",
    "xls",
    "xlsx",
    "xz",
    "zip",
  ].map((extension) => `.${extension}`),
);

/** The first `limit` bytes of a file, read without loading the rest. */
export function readFilePrefix(
  path: string,
  limit: number,
): { data: Buffer; size: number; mtimeMs: number } {
  const descriptor = openSync(path, "r");
  try {
    const stat = fstatSync(descriptor);
    const data = Buffer.alloc(Math.min(limit, stat.size));
    let offset = 0;
    while (offset < data.length) {
      const read = readSync(
        descriptor,
        data,
        offset,
        data.length - offset,
        offset,
      );
      if (read === 0) break;
      offset += read;
    }
    return {
      data: data.subarray(0, offset),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  } finally {
    closeSync(descriptor);
  }
}

/** UTF-8 text cut before a character the byte limit split. */
export function utf8Prefix(data: Buffer): string {
  let start = data.length - 1;
  while (start > 0 && data.length - start < 4 && (data[start]! & 0xc0) === 0x80)
    start -= 1;
  if (start < 0) return "";
  const lead = data[start]!;
  const width = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  const end = start + width <= data.length ? data.length : start;
  return data.subarray(0, end).toString("utf8");
}

/** Whether bytes look like a binary file: a NUL in the first 8 KB. */
export function looksBinary(data: Buffer): boolean {
  return data.subarray(0, 8192).includes(0);
}

/**
 * The ledger entry a reader names: by its absolute path, or by the path
 * relative to the workspace that the session's file list shows beside it.
 * A relative path two recorded files share names neither.
 */
export function sessionFileEntry(
  files: SessionFileEntry[],
  workspacePath: string,
  path: string,
): SessionFileEntry | undefined {
  const exact = files.find((file) => file.path === path);
  if (exact || !path.trim() || isAbsolute(path)) return exact;
  const relativePath = normalize(path);
  const absolute = resolve(workspacePath, relativePath);
  const matches = files.filter(
    (file) =>
      (file.workspacePath !== undefined &&
        normalize(file.workspacePath) === relativePath) ||
      file.path === absolute,
  );
  if (matches.length > 1)
    throw new Error(
      `${path} names more than one file this chat recorded; use its absolute path.`,
    );
  return matches[0];
}

/**
 * Reads one of a session's recorded files. Only paths in the session's
 * ledger are served, and only while they still resolve where they did when
 * recorded; private locations are refused whatever the ledger says.
 */
interface SessionFileReadInput {
  workspacePath: string;
  sessionsRoot?: string;
  sessionId: string;
  path: string;
  home?: string;
}

function sessionFileForRead(input: SessionFileReadInput) {
  const sessionsRoot =
    input.sessionsRoot ?? resolve(input.workspacePath, ".foundry", "sessions");
  const entry = sessionFileEntry(
    readSessionFileLedger(sessionsRoot, input.sessionId),
    input.workspacePath,
    input.path,
  );
  if (!entry)
    throw new Error(
      "This file is not one this chat's tools wrote or its answers named.",
    );
  const home = input.home ?? homedir();
  const workspaceRealpath = realpathOrSelf(input.workspacePath);
  const base: SessionFileRead = {
    sessionId: input.sessionId,
    path: entry.path,
    ...(entry.workspacePath ? { workspacePath: entry.workspacePath } : {}),
    origin: entry.origin,
    insideWorkspace: within(workspaceRealpath, entry.realpath),
    kind: "missing",
    truncated: false,
    changedSinceRecorded: false,
  };
  let realpath: string;
  try {
    realpath = realpathSync(entry.path);
  } catch {
    return { base };
  }
  if (
    realpath !== entry.realpath ||
    privateDevicePath(entry.path, home, input.workspacePath) ||
    privateDevicePath(realpath, home, workspaceRealpath)
  )
    throw new Error("This file now resolves somewhere else and is not shown.");
  if (!statSync(realpath).isFile())
    throw new Error("This path is no longer a regular file.");
  return { base, realpath, entry, workspaceRealpath };
}

export function readSessionFileChunk(
  input: SessionFileReadInput & { download: FileDownloadRequest },
) {
  const { base, realpath } = sessionFileForRead(input);
  if (!realpath) throw new Error("file not found");
  return {
    ...base,
    kind: "binary" as const,
    downloadChunk: readFileDownloadChunk(realpath, input.download),
  };
}

export function readSessionFile(input: SessionFileReadInput): SessionFileRead {
  const { base, realpath, entry, workspaceRealpath } =
    sessionFileForRead(input);
  if (!realpath || !entry || !workspaceRealpath) return base;
  const extension = extname(realpath).toLowerCase();
  const image = imageTypes[extension];
  const read = readFilePrefix(
    realpath,
    image ? maxImageBytes + 1 : maxTextBytes + 1,
  );
  const file: SessionFileRead = {
    ...base,
    insideWorkspace: within(workspaceRealpath, realpath),
    bytes: read.size,
    mtime: new Date(read.mtimeMs).toISOString(),
    changedSinceRecorded:
      entry.mtimeMs !== undefined && Math.abs(read.mtimeMs - entry.mtimeMs) > 1,
  };
  if (image && read.size <= maxImageBytes)
    return {
      ...file,
      kind: "image",
      mimeType: image,
      dataBase64: read.data.toString("base64"),
    };
  if (image || binaryExtensions.has(extension) || looksBinary(read.data))
    return { ...file, kind: "binary" };
  const truncated = read.size > maxTextBytes;
  return {
    ...file,
    kind: "text",
    content: utf8Prefix(
      truncated ? read.data.subarray(0, maxTextBytes) : read.data,
    ),
    truncated,
  };
}

/**
 * What the session's own writes changed in one of its recorded files: one
 * turn's (`inputId`) or the whole session's, from the copy kept before its
 * first write to the one kept after its last. Only files the session's tools
 * wrote have one, and only while they resolve where they did when recorded.
 */
export async function readSessionFileDiff(input: {
  workspacePath: string;
  sessionsRoot?: string;
  sessionId: string;
  path: string;
  inputId?: string;
  home?: string;
}): Promise<SessionFileDiff> {
  const sessionsRoot =
    input.sessionsRoot ?? resolve(input.workspacePath, ".foundry", "sessions");
  const entry = sessionFileEntry(
    readSessionFileLedger(sessionsRoot, input.sessionId),
    input.workspacePath,
    input.path,
  );
  if (!entry || entry.origin !== "tool")
    throw new Error("This file is not one this chat's tools wrote.");
  if (input.inputId && !entry.inputIds.includes(input.inputId))
    throw new Error("This turn did not write this file.");
  const home = input.home ?? homedir();
  const workspaceRealpath = realpathOrSelf(input.workspacePath);
  let realpath: string | undefined;
  try {
    realpath = realpathSync(entry.path);
  } catch {
    realpath = undefined;
  }
  if (
    (realpath !== undefined && realpath !== entry.realpath) ||
    privateDevicePath(entry.path, home, input.workspacePath) ||
    privateDevicePath(realpath ?? entry.realpath, home, workspaceRealpath)
  )
    throw new Error("This file now resolves somewhere else and is not shown.");

  const change = await sessionFileChange(
    sessionsRoot,
    input.sessionId,
    entry.path,
    input.inputId,
  );
  const current = currentFile(entry.path);
  const base: SessionFileDiff = {
    sessionId: input.sessionId,
    path: entry.path,
    ...(entry.workspacePath ? { workspacePath: entry.workspacePath } : {}),
    origin: entry.origin,
    insideWorkspace: within(workspaceRealpath, realpath ?? entry.realpath),
    ...(input.inputId ? { inputId: input.inputId } : {}),
    source: change?.source ?? "hook",
    beforeLabel: "beforeEdits",
    afterLabel: "afterEdits",
    mayIncludeOtherEdits: change?.otherEdits ?? false,
    changedSince: false,
    truncated: false,
    binary: false,
    tooLarge: false,
  };
  if (!change) return { ...base, unavailable: "noBaseline" };
  const after = change.after ?? current;
  const diff: SessionFileDiff = {
    ...base,
    beforeLabel:
      change.before.snapshot.kind === "absent"
        ? "empty"
        : change.source === "git-snapshot"
          ? "turnStart"
          : "beforeEdits",
    afterLabel:
      after.snapshot.kind === "absent"
        ? "deleted"
        : change.after
          ? "afterEdits"
          : "current",
    changedSince:
      change.after !== undefined &&
      !sameSnapshot(change.after.snapshot, current.snapshot),
  };
  const available = diffAvailability(change, after);
  if (available === "binary") return { ...diff, binary: true };
  if (available === "tooLarge") return { ...diff, tooLarge: true };
  if (available === "noBaseline") return { ...diff, unavailable: "noBaseline" };
  const counts = lineChangeCounts(change.before.text!, after.text!);
  return {
    ...diff,
    before: change.before.text!,
    after: after.text!,
    ...(counts ?? {}),
  };
}
