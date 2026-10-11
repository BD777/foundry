// What this worker has uploaded of each native chat, per server and
// workspace, kept in its state root: a restarted or updated worker sends only
// the chats that changed since, not every chat with its full transcript.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ChatThread } from "@bd777/foundry-protocol";
import { foundryStatePath } from "./state-root.js";
import { writePrivateJSONAtomic } from "./storage.js";
import { getJSON } from "./transport.js";

/** Uploads remembered per server and workspace; the oldest go first. */
const uploadsKept = 5000;

interface ChatUploadsFile {
  version: 1;
  serverURL: string;
  workspaceId: string;
  /** Chat id to the fingerprint of the content last uploaded. */
  uploaded: Record<string, string>;
  /** Chats the server said it never keeps. */
  refused: string[];
}

export interface ChatUploads {
  uploaded: Map<string, string>;
  refused: Set<string>;
  /** Whether a record was found: false on a first run, e.g. after updating. */
  recorded: boolean;
  /** Whether this process compared the record with the server's chats. */
  reconciled: boolean;
  save(): void;
}

/** A chat's content: its time is its last activity, never a label. */
export function chatFingerprint(chat: ChatThread): string {
  return createHash("sha256").update(JSON.stringify(chat)).digest("hex");
}

function uploadsPath(serverURL: string, workspaceId: string): string {
  const key = createHash("sha256")
    .update(`${serverURL}\n${workspaceId}`)
    .digest("hex")
    .slice(0, 40);
  return foundryStatePath("chat-uploads", `${key}.json`);
}

function readUploadsFile(
  path: string,
  serverURL: string,
  workspaceId: string,
): ChatUploadsFile | undefined {
  try {
    const value = JSON.parse(
      readFileSync(path, "utf8"),
    ) as Partial<ChatUploadsFile>;
    if (
      value.version === 1 &&
      value.serverURL === serverURL &&
      value.workspaceId === workspaceId &&
      value.uploaded &&
      typeof value.uploaded === "object" &&
      Array.isArray(value.refused)
    )
      return value as ChatUploadsFile;
  } catch {
    // Missing or unreadable: no record.
  }
  return undefined;
}

const loaded = new Map<string, ChatUploads>();

/** The upload record of a server and workspace, read once per process. */
export function chatUploads(
  serverURL: string,
  workspaceId: string,
): ChatUploads {
  const path = uploadsPath(serverURL, workspaceId);
  const known = loaded.get(path);
  if (known) return known;
  const file = readUploadsFile(path, serverURL, workspaceId);
  const uploads: ChatUploads = {
    uploaded: new Map(
      Object.entries(file?.uploaded ?? {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    refused: new Set(
      (file?.refused ?? []).filter((id) => typeof id === "string"),
    ),
    recorded: Boolean(file),
    reconciled: false,
    save() {
      for (const id of [...this.uploaded.keys()].slice(
        0,
        Math.max(0, this.uploaded.size - uploadsKept),
      ))
        this.uploaded.delete(id);
      const refused = [...this.refused].slice(-uploadsKept);
      try {
        writePrivateJSONAtomic(path, {
          version: 1,
          serverURL,
          workspaceId,
          uploaded: Object.fromEntries(this.uploaded),
          refused,
        } satisfies ChatUploadsFile);
        this.recorded = true;
      } catch (error) {
        // Chats still sync; a restart would only send them once more.
        console.warn(
          `Could not record the chats uploaded to ${serverURL}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
  loaded.set(path, uploads);
  return uploads;
}

/** Records an upload, the newest last. */
export function rememberUpload(
  uploads: ChatUploads,
  chat: ChatThread,
  fingerprint = chatFingerprint(chat),
): void {
  uploads.uploaded.delete(chat.id);
  uploads.uploaded.set(chat.id, fingerprint);
}

/** What the server holds of a native chat (GET /api/daemon/chats/digests). */
interface ServerChatDigest {
  id: string;
  updatedAt?: string;
  status?: string;
  answerRevision?: string;
  title?: string;
  preview?: string;
  transcriptMessages?: number;
}

/**
 * Compares the record with what the server holds, once per worker process
 * (reconciled). A chat the server does not hold (its data was reset or lost)
 * is sent again. On a first run without a record (the first after updating
 * from a worker that kept none, or a lost state root), the chats the server
 * already holds as they are here count as uploaded: same activity time,
 * status, answer, title, preview and transcript length, a transcript
 * included. A server without the digest list (older than this worker)
 * answers nothing: every chat is sent once, as before. Returns false when the
 * server did not answer the list.
 */
export async function reconcileWithServer(
  serverURL: string,
  workspaceId: string,
  uploads: ChatUploads,
  chats: readonly ChatThread[],
): Promise<boolean> {
  // Asked once: a server without the list is not asked on every sync.
  uploads.reconciled = true;
  let digests: ServerChatDigest[];
  try {
    digests =
      (
        await getJSON<{ chats?: ServerChatDigest[] }>(
          serverURL,
          `/api/daemon/chats/digests?workspaceId=${encodeURIComponent(workspaceId)}`,
        )
      ).chats ?? [];
  } catch {
    return false;
  }
  const held = new Map(digests.map((digest) => [digest.id, digest]));
  for (const chat of chats) {
    const digest = held.get(chat.id);
    if (!digest) {
      uploads.uploaded.delete(chat.id);
      continue;
    }
    if (uploads.recorded) continue;
    const messages = chat.transcript?.length ?? 0;
    if (
      messages > 0 &&
      digest.transcriptMessages === messages &&
      (digest.updatedAt ?? "") === (chat.updatedAt ?? "") &&
      (digest.status ?? "") === (chat.status ?? "") &&
      (digest.answerRevision ?? "") === (chat.answerRevision ?? "") &&
      (digest.title ?? "") === chat.title &&
      (digest.preview ?? "") === chat.preview
    )
      rememberUpload(uploads, chat);
  }
  return true;
}
