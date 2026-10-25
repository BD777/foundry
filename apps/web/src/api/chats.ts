import type {
  AgentSession,
  ChatAttachment,
  ChatLayout,
  ChatQueue,
  ChatThread,
  ChatTitle,
  EditChatQueueItemInput,
  TranscriptMessage,
  EnqueueChatMessageInput,
} from "@bd777/foundry-protocol";
import type { UploadChatAttachmentsInput } from "../api-types";
import { apiBaseUrl } from "../lib/api-base-url";
import {
  apiFetch,
  notifyAuthRequired,
  request,
  requestInit,
  sharedGetJSON,
  sharedReads,
  type RequestOptions,
} from "./http";

export function getChatLayout(
  workspaceId: string,
  options: RequestOptions = {},
): Promise<ChatLayout> {
  return sharedGetJSON(
    `/api/chat-layout?workspaceId=${encodeURIComponent(workspaceId)}`,
    options,
  );
}

export function saveChatLayout(
  workspaceId: string,
  layout: ChatLayout,
): Promise<ChatLayout> {
  return request("POST", "/api/chat-layout", {
    body: { workspaceId, expectedRevision: layout.revision, layout },
  });
}

export function deleteChatGroup(
  workspaceId: string,
  groupId: string,
  expectedRevision: number,
): Promise<ChatLayout> {
  return request("POST", "/api/chat-layout/delete-group", {
    body: { workspaceId, groupId, expectedRevision },
  });
}

export function listChatTitles(
  workspaceId: string,
  options: RequestOptions = {},
): Promise<ChatTitle[]> {
  return sharedGetJSON(
    `/api/chat-titles?workspaceId=${encodeURIComponent(workspaceId)}`,
    options,
  );
}

export function renameChat(
  chatId: string,
  workspaceId: string,
  title: string,
): Promise<ChatTitle> {
  return request("POST", `/api/chats/${encodeURIComponent(chatId)}/title`, {
    body: { workspaceId, title },
  });
}

export function recapChatTitle(
  chatId: string,
  workspaceId: string,
): Promise<AgentSession> {
  return request(
    "POST",
    `/api/chats/${encodeURIComponent(chatId)}/recap-title`,
    { body: { workspaceId } },
  );
}

export function getChat(
  chatId: string,
  options: RequestOptions = {},
): Promise<ChatThread> {
  return request("GET", `/api/chats/${encodeURIComponent(chatId)}`, options);
}

/** A page of a native chat's earlier log, read from its device. */
export interface NativeChatHistoryPage {
  transcript: TranscriptMessage[];
  /** Where the page starts in the log; 0 at the log's start. */
  before: number;
}

export function getNativeChatHistory(
  chatId: string,
  before: number,
  options: RequestOptions = {},
): Promise<NativeChatHistoryPage> {
  return request(
    "GET",
    `/api/chats/${encodeURIComponent(chatId)}/history?before=${before}`,
    options,
  );
}

export function uploadChatAttachments(
  input: UploadChatAttachmentsInput,
): Promise<ChatAttachment[]> {
  const body = new FormData();
  body.set("workspaceId", input.workspaceId);
  input.files.forEach((file) => body.append("files", file));
  return request("POST", "/api/attachments", { body });
}

/**
 * How a change to a chat's queue went. A refusal (409) carries the queue as
 * the server has it now and why: the message was already sent ("already_sent"),
 * is being sent ("sending"), or the queue changed ("changed").
 */
export type ChatQueueResult =
  | { ok: true; queue: ChatQueue }
  | {
      ok: false;
      status: number;
      error: string;
      code?: "already_sent" | "sending" | "changed";
      queue?: ChatQueue;
    };

async function chatQueueRequest(
  method: string,
  path: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<ChatQueueResult> {
  const response = await apiFetch(
    `${apiBaseUrl}${path}`,
    requestInit(method, { body, idempotencyKey }),
  );
  return chatQueueResult(
    response.status,
    await response.text().catch(() => ""),
    path,
  );
}

function chatQueueResult(
  status: number,
  text: string,
  path: string,
): ChatQueueResult {
  let payload:
    | (ChatQueue & {
        error?: string;
        code?: "already_sent" | "sending" | "changed";
        queue?: ChatQueue;
      })
    | undefined;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = undefined;
  }
  if (status >= 200 && status < 300 && payload)
    return { ok: true, queue: payload };
  return {
    ok: false,
    status,
    error: payload?.error ?? `${path} returned ${status}`,
    code: payload?.code,
    queue: payload?.queue,
  };
}

function chatQueuePath(chatId: string, rest = ""): string {
  return `/api/chats/${encodeURIComponent(chatId)}/queue${rest}`;
}

/** The chat's queue; tabs showing the chat share the read (sharedReads). */
export async function getChatQueue(
  chatId: string,
  options: RequestOptions = {},
): Promise<ChatQueueResult> {
  const path = chatQueuePath(chatId);
  const answer = await sharedReads.read(path, options.signal);
  if (answer.status === 401) notifyAuthRequired();
  return chatQueueResult(answer.status, answer.body, path);
}

/** The idempotency key makes a repeated request (a reload, another tab) add the message once. */
export function enqueueChatMessage(
  chatId: string,
  input: EnqueueChatMessageInput,
  idempotencyKey: string,
): Promise<ChatQueueResult> {
  return chatQueueRequest("POST", chatQueuePath(chatId), input, idempotencyKey);
}

export function editChatQueueItem(
  chatId: string,
  itemId: string,
  input: EditChatQueueItemInput,
): Promise<ChatQueueResult> {
  return chatQueueRequest(
    "PATCH",
    chatQueuePath(chatId, `/${encodeURIComponent(itemId)}`),
    input,
  );
}

export function deleteChatQueueItem(
  chatId: string,
  itemId: string,
): Promise<ChatQueueResult> {
  return chatQueueRequest(
    "DELETE",
    chatQueuePath(chatId, `/${encodeURIComponent(itemId)}`),
  );
}

export function reorderChatQueue(
  chatId: string,
  itemIds: string[],
  expectedRevision: number,
): Promise<ChatQueueResult> {
  return chatQueueRequest("PUT", chatQueuePath(chatId, "/order"), {
    itemIds,
    expectedRevision,
  });
}

export function steerChatQueueItem(
  chatId: string,
  itemId: string,
): Promise<ChatQueueResult> {
  return chatQueueRequest(
    "POST",
    chatQueuePath(chatId, `/${encodeURIComponent(itemId)}/steer`),
  );
}

export function retryChatQueueItem(
  chatId: string,
  itemId: string,
): Promise<ChatQueueResult> {
  return chatQueueRequest(
    "POST",
    chatQueuePath(chatId, `/${encodeURIComponent(itemId)}/retry`),
  );
}
