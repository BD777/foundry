/**
 * Session helpers — file/subagent operations and session event management.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type WebSocket from "ws";
import {
  daemonMessageTypes,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionEventMetadata,
  type AgentSubagentSummary,
  type AgentSubagentTranscript,
  type WorkspaceDirectoryEntry,
  type WorkspaceFileEntry,
  type WorkspaceFileRead,
  type WorkspaceTreeEntry,
} from "@foundry/protocol";
import { sendWebSocket, trySendWebSocket } from "./transport.js";
import {
  listAgentSubagents,
  readAgentSubagentTranscript,
} from "./subagent-transcript.js";
import {
  activeSessionCancelTargets,
  activeSessionSteerTargets,
  queuedSessionCancelRequests,
  type ActiveSessionCancelTarget,
  type ActiveSessionSteerTarget,
  type AgentSessionRunResult,
} from "./session-state.js";
import { safeID } from "./utils.js";
import { writePrivateJSONAtomic } from "./storage.js";

// --- Payload types ---

export interface ReadFilePayload {
  path: string;
  workspaceId: string;
}

export interface ReadSubagentTranscriptPayload {
  sessionId: string;
  taskId: string;
  workspaceId: string;
}

export interface ListSubagentsPayload {
  sessionId: string;
  workspaceId: string;
}

export interface ListDirectoriesPayload {
  path: string;
}

export interface ListWorkspaceTreePayload {
  path?: string;
  workspaceId: string;
}

export interface AgentSessionCompletionMarker {
  completedAt: string;
  nativeSessionId?: string;
  response: string;
  sessionId: string;
  status: "completed";
}

// --- Response stream event ID allocator ---

export function createSessionStatusEventFilter(): (
  event: Pick<AgentSessionEvent, "label" | "detail" | "level" | "metadata">,
) => boolean {
  let previousStatus: string | undefined;
  return (event) => {
    const status =
      event.level === "info" &&
      !event.metadata &&
      (event.label === "正在请求模型" || event.label === "正在压缩上下文")
        ? JSON.stringify([event.label, event.detail])
        : undefined;
    const duplicate = status !== undefined && status === previousStatus;
    previousStatus = status;
    return !duplicate;
  };
}

export function createResponseStreamEventIDAllocator(
  sessionID: string,
): (label: string, messageID?: string) => string | undefined {
  let responseStreamOrdinal = 1;
  let responseStreamOpen = false;
  let lastMessageID: string | undefined;
  const messageEvents = new Map<string, string>();
  return (label: string, messageID?: string): string | undefined => {
    if (label === "Response stream") {
      if (messageID && messageEvents.has(messageID))
        return messageEvents.get(messageID);
      if (
        responseStreamOpen &&
        messageID &&
        lastMessageID &&
        messageID !== lastMessageID
      )
        responseStreamOrdinal += 1;
      const eventID =
        responseStreamOrdinal === 1
          ? `evt_${sessionID}_response_stream`
          : `evt_${sessionID}_response_stream_${responseStreamOrdinal}`;
      responseStreamOpen = true;
      lastMessageID = messageID;
      if (messageID) messageEvents.set(messageID, eventID);
      return eventID;
    }
    if (responseStreamOpen && label !== "正在请求模型") {
      responseStreamOrdinal += 1;
      responseStreamOpen = false;
    }
    return undefined;
  };
}

/**
 * Resolves a path inside the workspace through symlinks and refuses anything
 * that lands outside it, so a link in the workspace cannot expose other files.
 */
function workspaceRealPath(
  workspacePath: string,
  path: string,
  outside: string,
): { root: string; target: string } {
  const escapes = (from: string, to: string) => {
    const relativePath = relative(from, to);
    return (
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    );
  };
  if (escapes(resolve(workspacePath), resolve(workspacePath, path)))
    throw new Error(outside);
  const root = realpathSync(workspacePath);
  const target = realpathSync(resolve(root, path));
  if (escapes(root, target)) throw new Error(outside);
  return { root, target };
}

// Git internals can hold credentials (remote URLs, config) and are never
// served to people who can only see the workspace.
function refuseGitInternals(root: string, target: string): void {
  if (relative(root, target).split(sep).includes(".git"))
    throw new Error("Git internals are not readable through Foundry");
}

export function safeWorkspaceFileRead(
  workspacePath: string,
  payload: ReadFilePayload,
): WorkspaceFileRead {
  const root = resolve(workspacePath);
  const target = resolve(root, payload.path);
  const relativePath = relative(root, target);
  if (
    relativePath === "" ||
    relativePath.startsWith("..") ||
    resolve(relativePath) === relativePath
  ) {
    throw new Error("requested file is outside the paired workspace");
  }
  const real = workspaceRealPath(
    root,
    relativePath,
    "requested file is outside the paired workspace",
  );
  refuseGitInternals(real.root, real.target);
  const stat = statSync(real.target);
  if (!stat.isFile()) {
    throw new Error("requested workspace path is not a file");
  }
  const maxBytes = 128 * 1024;
  const raw = readFileSync(target);
  const truncated = raw.byteLength > maxBytes;
  return {
    workspaceId: payload.workspaceId,
    path: payload.path,
    content: raw.subarray(0, maxBytes).toString("utf8"),
    truncated,
  };
}

export function resolveLocalBrowserPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "" || trimmed === "~") {
    return homedir();
  }
  if (trimmed.startsWith("~/")) {
    return resolve(homedir(), trimmed.slice(2));
  }
  return resolve(trimmed);
}

export function safeDirectoryListing(path: string): WorkspaceDirectoryEntry[] {
  const target = resolveLocalBrowserPath(path);
  const stat = statSync(target);
  if (!stat.isDirectory()) {
    throw new Error("selected path is not a directory");
  }

  return readdirSync(target, { withFileTypes: true })
    .flatMap((entry): WorkspaceDirectoryEntry[] => {
      const childPath = resolve(target, entry.name);
      let childStat;
      try {
        childStat = statSync(childPath);
      } catch {
        return [];
      }
      if (!childStat.isDirectory()) {
        return [];
      }
      return [
        {
          id: `dir_${safeID(childPath)}`,
          name: entry.name,
          path: childPath,
        },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 200);
}

export function sendFileRead(
  socket: WebSocket,
  id: string | undefined,
  workspacePath: string,
  payload: ReadFilePayload,
): void {
  try {
    sendWebSocket(
      socket,
      daemonMessageTypes.fileRead,
      safeWorkspaceFileRead(workspacePath, payload),
      id,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendWebSocket(
      socket,
      daemonMessageTypes.fileRead,
      {
        workspaceId: payload.workspaceId,
        path: payload.path,
        content: "",
        truncated: false,
        error: message,
      },
      id,
    );
  }
}

export async function sendSubagentTranscript(
  socket: WebSocket,
  id: string | undefined,
  workspacePath: string,
  payload: ReadSubagentTranscriptPayload,
): Promise<void> {
  try {
    sendWebSocket(
      socket,
      daemonMessageTypes.subagentTranscriptRead,
      await readAgentSubagentTranscript(
        workspacePath,
        payload.sessionId,
        payload.taskId,
      ),
      id,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendWebSocket(
      socket,
      daemonMessageTypes.subagentTranscriptRead,
      {
        sessionId: payload.sessionId,
        taskId: payload.taskId,
        title: "Subagent",
        toolUseId: "",
        status: "failed",
        messages: [],
        error: message,
      } satisfies AgentSubagentTranscript & { error: string },
      id,
    );
  }
}

export async function sendSubagentList(
  socket: WebSocket,
  id: string | undefined,
  workspacePath: string,
  payload: ListSubagentsPayload,
): Promise<void> {
  try {
    sendWebSocket(
      socket,
      daemonMessageTypes.subagentsListed,
      {
        sessionId: payload.sessionId,
        subagents: await listAgentSubagents(workspacePath, payload.sessionId),
      },
      id,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendWebSocket(
      socket,
      daemonMessageTypes.subagentsListed,
      {
        sessionId: payload.sessionId,
        subagents: [] as AgentSubagentSummary[],
        error: message,
      },
      id,
    );
  }
}

export function sendDirectoryListing(
  socket: WebSocket,
  id: string | undefined,
  payload: ListDirectoriesPayload,
): void {
  try {
    sendWebSocket(
      socket,
      daemonMessageTypes.directoriesListed,
      {
        path: payload.path,
        directories: safeDirectoryListing(payload.path),
      },
      id,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendWebSocket(
      socket,
      daemonMessageTypes.directoriesListed,
      {
        path: payload.path,
        directories: [],
        error: message,
      },
      id,
    );
  }
}

const TREE_IGNORED_NAMES = new Set([".DS_Store", ".git"]);

export function safeWorkspaceTreeListing(
  workspacePath: string,
  subPath = "",
): WorkspaceTreeEntry[] {
  const { root, target } = workspaceRealPath(
    workspacePath,
    subPath,
    "requested path is outside the workspace",
  );
  refuseGitInternals(root, target);
  const stat = statSync(target);
  if (!stat.isDirectory()) {
    throw new Error("requested path is not a directory");
  }

  return readdirSync(target, { withFileTypes: true })
    .filter((entry) => !TREE_IGNORED_NAMES.has(entry.name))
    .map((entry): WorkspaceTreeEntry => {
      const childPath = resolve(target, entry.name);
      const childRelPath = relative(root, childPath);
      const isDir = entry.isDirectory();
      let size: number | undefined;
      try {
        if (!isDir) {
          size = statSync(childPath).size;
        }
      } catch {
        // best-effort size
      }
      const extension = !isDir ? extname(entry.name).toLowerCase() : undefined;
      return {
        extension,
        id: `tree_${safeID(childRelPath)}`,
        isDirectory: isDir,
        name: entry.name,
        path: childRelPath,
        size,
      };
    })
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
}

export function sendWorkspaceTreeListing(
  socket: WebSocket,
  id: string | undefined,
  workspacePath: string,
  payload: ListWorkspaceTreePayload,
): void {
  try {
    sendWebSocket(
      socket,
      daemonMessageTypes.workspaceTreeListed,
      {
        entries: safeWorkspaceTreeListing(workspacePath, payload.path),
        path: payload.path ?? "",
        workspaceId: payload.workspaceId,
      },
      id,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendWebSocket(
      socket,
      daemonMessageTypes.workspaceTreeListed,
      {
        entries: [],
        error: message,
        path: payload.path ?? "",
        workspaceId: payload.workspaceId,
      },
      id,
    );
  }
}
export function sessionEvent(
  sessionID: string,
  label: string,
  detail: string,
  level: AgentSessionEvent["level"] = "info",
  eventID?: string,
  metadata?: AgentSessionEventMetadata,
  message?: AgentSessionEvent["message"],
): AgentSessionEvent {
  const id =
    eventID ??
    `evt_${sessionID}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return {
    id,
    sessionId: sessionID,
    at: "just now",
    label,
    detail,
    level,
    metadata,
    message: message ? { ...message, id: message.id || id } : undefined,
  };
}

export function registerActiveSessionSteerTarget(
  sessionID: string,
  target: ActiveSessionSteerTarget,
): () => void {
  activeSessionSteerTargets.set(sessionID, target);
  return () => {
    if (activeSessionSteerTargets.get(sessionID) === target) {
      activeSessionSteerTargets.delete(sessionID);
    }
  };
}

export function registerActiveSessionCancelTarget(
  sessionID: string,
  target: ActiveSessionCancelTarget,
): () => void {
  activeSessionCancelTargets.set(sessionID, target);
  return () => {
    if (activeSessionCancelTargets.get(sessionID) === target) {
      activeSessionCancelTargets.delete(sessionID);
    }
  };
}

export async function steerActiveSession(
  sessionID: string,
  message: string,
): Promise<void> {
  const target = activeSessionSteerTargets.get(sessionID);
  if (!target) {
    throw new Error("This session is not accepting active steer input.");
  }
  await target.steer(message);
}

class AgentSessionCanceledError extends Error {
  constructor(message = "Session canceled by user.") {
    super(message);
    this.name = "AgentSessionCanceledError";
  }
}

export function isAgentSessionCanceledError(error: unknown): boolean {
  return (
    error instanceof AgentSessionCanceledError ||
    (error instanceof Error && error.name === "AgentSessionCanceledError")
  );
}

export function writeAgentSessionCompletionMarker(
  workspacePath: string,
  session: AgentSession,
  result: AgentSessionRunResult,
): void {
  const markerPath = resolve(
    workspacePath,
    ".foundry",
    "sessions",
    session.id,
    "completion.json",
  );
  const marker: AgentSessionCompletionMarker = {
    completedAt: new Date().toISOString(),
    nativeSessionId: result.nativeSessionId,
    response: result.response,
    sessionId: session.id,
    status: "completed",
  };
  writePrivateJSONAtomic(markerPath, marker);
}

export async function cancelActiveSession(sessionID: string): Promise<void> {
  const target = activeSessionCancelTargets.get(sessionID);
  if (!target) {
    queuedSessionCancelRequests.add(sessionID);
    return;
  }
  await target.cancel();
}
