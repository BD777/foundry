import { request, type RequestOptions } from "./http";

/**
 * Where a pending item was found (DEV-079): in a session or an Issue; or,
 * the person's own (DEV-125), a connected account to authorize again
 * ("account") or a device's sign-in that expired ("connector").
 */
export type PendingSource =
  | "question"
  | "issue_question"
  | "turn_failed"
  | "needs_hands"
  | "answer"
  | "account"
  | "connector";

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
  /**
   * What a needs_hands item matched; an Issue question's kind; the
   * connector kind of an account or connector item (its Connectors tab).
   */
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

/**
 * What reads the person's answers for what they ask of them (DEV-125):
 * off until chosen; a connection on one of their devices, its model and
 * effort (empty: the connection's or model's default).
 */
export interface PendingTriageSettings {
  enabled: boolean;
  deviceId?: string;
  runtime?: "claude" | "codex" | "";
  profileId?: string;
  model?: string;
  effort?: string;
  updatedAt?: string;
}

export function getPendingTriage(
  options: RequestOptions = {},
): Promise<PendingTriageSettings> {
  return request("GET", "/api/pending-items/triage", options);
}

export function savePendingTriage(
  settings: PendingTriageSettings,
): Promise<PendingTriageSettings> {
  return request("PUT", "/api/pending-items/triage", { body: settings });
}
