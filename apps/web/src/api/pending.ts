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
  | "account"
  | "connector"
  | "helper_stuck"
  /** A bundle update whose canary check failed was rolled back (DEV-154). */
  | "bundle_update"
  /**
   * A message channel hit its delivery limit or its feed had a gap
   * (DEV-203); it names the assistant and opens its channels.
   */
  | "message_channel";

/**
 * Who handles an open item (docs/assistant-orchestration.md §h): the person
 * (also when absent), or their assistant, for its own helpers' items.
 */
export type PendingHandler = "person" | "assistant";

/**
 * Why an item the assistant handled came to the person: it handed it over
 * (with its note), it was stopped, its computer was offline, or its
 * 10-minute deadline passed without acknowledgement.
 */
export type PendingHandedReason =
  "assistant" | "assistant_stopped" | "assistant_offline" | "assistant_timeout";

/** How the item ended; escalation is replaced by the person's later action. */
export type PendingOutcome =
  | "assistant_answered"
  | "handed_over"
  | "escalated_timeout"
  | "auto_resolved"
  | "person_answered"
  | "person_dismissed_not_needed";

export type PendingState =
  "open" | "replied" | "superseded" | "done" | "dismissed";

/**
 * Something in a session that waits for the person, in its source's own
 * words: a question an Agent asked, an Issue's question, a turn that failed,
 * a tool error only the person can clear.
 */
export interface PendingItem {
  id: string;
  /** The assistant this item belongs to, or absent when unassigned. */
  assistantId?: string;
  /** Its label as the person sees it in the needs-you filter. */
  assistantName?: string;
  workspaceId: string;
  workspaceName?: string;
  sessionId?: string;
  sessionTitle?: string;
  /** The session's device (a github_scope item opens its GitHub permissions). */
  deviceId?: string;
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
  handler?: PendingHandler;
  /** What the assistant told the person when it handed the item over. */
  note?: string;
  handedReason?: PendingHandedReason;
  handedAt?: string;
  deadlineAt?: string;
  acknowledgedAt?: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  outcome?: PendingOutcome;
}

export interface PendingItemList {
  /** Open items and those resolved in the last week, newest first. */
  items: PendingItem[];
  /** Every assistant the person has, for filtering the global list. */
  assistants: PendingAssistant[];
  /** Open items the person handles. */
  open: number;
  /** Open items their assistant handles. */
  assistantOpen?: number;
  /** The person's open items per chat (Issue questions are counted on the Issue). */
  bySession: Record<string, number>;
}

export interface PendingAssistant {
  id: string;
  name: string;
  isDefault: boolean;
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
