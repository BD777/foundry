import { request, type RequestOptions } from "./http";

/** Where a pending item was found (DEV-079). */
export type PendingSource =
  "question" | "issue_question" | "turn_failed" | "needs_hands";

export type PendingState =
  "open" | "replied" | "superseded" | "done" | "dismissed";

/**
 * Something in a session that waits for the person, in its source's own
 * words: a question an Agent asked, an Issue's question, a turn that failed,
 * a tool error only the person can clear.
 */
export interface PendingItem {
  id: string;
  workspaceId: string;
  workspaceName?: string;
  sessionId?: string;
  sessionTitle?: string;
  issueId?: string;
  /** The transcript event, and message, it was found in. */
  eventId?: string;
  messageId?: string;
  source: PendingSource;
  /** What a needs_hands item matched; an Issue question's kind. */
  rule?: string;
  state: PendingState;
  title: string;
  excerpt: string;
  context?: string;
  options?: string[];
  recommendation?: string;
  occurrences: number;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

export interface PendingItemList {
  /** Open items and those resolved in the last week, newest first. */
  items: PendingItem[];
  open: number;
  /** Open items per chat (Issue questions are counted on the Issue). */
  bySession: Record<string, number>;
}

export function listPendingItems(
  options: RequestOptions = {},
): Promise<PendingItemList> {
  return request("GET", "/api/pending-items", options);
}

/** Marks an item done or dismissed by hand, or opens it again. */
export function setPendingItemState(
  id: string,
  state: "open" | "done" | "dismissed",
): Promise<PendingItem> {
  return request("POST", `/api/pending-items/${encodeURIComponent(id)}/state`, {
    body: { state },
  });
}
