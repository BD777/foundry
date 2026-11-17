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
  | "message_channel"
  /**
   * A saved message the person's assistant did not process (DEV-254): its
   * attempt failed or it waits on something only the person can fix. Its
   * rule is the waiting reason; a failed attempt names its category.
   */
  | "assistant_inbox"
  | "project_upkeep"
  | "memory_upkeep"
  /**
   * A connector write outside what the session was granted (DEV-265): the
   * person allows or refuses that exact request.
   */
  | "connector_write"
  /**
   * A note from the assistant that needs no decision (DEV-278): the person
   * reads it and dismisses it.
   */
  | "notice";

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

/** How a failed assistant attempt ended, as it was classified (DEV-254). */
export type PendingFailureCategory =
  | "quota_exhausted"
  | "rate_limited"
  | "provider_unavailable"
  | "provider_mismatch"
  | "host_stopped"
  | "other";

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
  /** How many things wait for the person, for an item that counts them (DEV-256). */
  count?: number;
  /** An unprocessed message's failed attempt: its category and reset time. */
  failureCategory?: PendingFailureCategory;
  failureResetAt?: string;
  /** When an unprocessed message was sent: its inbox entry's time (DEV-254). */
  messageAt?: string;
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
  /** What a connector-write item asks the person to decide (DEV-265). */
  connectorWrite?: PendingConnectorWriteDetail;
}

/** One connector write waiting for the person, in structured parts. */
export interface PendingConnectorWriteDetail {
  proposalId: string;
  /** What the write does: message, reaction, or write. */
  action?: "message" | "reaction" | "write";
  /** The operation in the person's words, e.g. 新建云文档. */
  operation?: string;
  /** When the approval expires. */
  expiresAt?: string;
  /** Top-level string fields of the recorded body, as "key: value". */
  preview?: string[];
  /** The recorded body as JSON, for a disclosure. */
  body?: string;
  accountName?: string;
  targetType?: string;
  targetId?: string;
  /** The target's name, resolved when the proposal was made; empty when
   * the connector could not name it. */
  targetName?: string;
  text?: string;
  /** The channel conversation the request came from, when it did. */
  channelName?: string;
  conversationKind?: string;
  conversationName?: string;
  /** The request came from a session the assistant handed work to. */
  fromHelper?: boolean;
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

/**
 * Asks for one more attempt of the saved message an unprocessed-message
 * item stands for (DEV-254). Only that source can be retried.
 */
export function retryPendingItem(
  id: string,
  requestId: string,
): Promise<PendingItem> {
  return request("POST", `/api/pending-items/${encodeURIComponent(id)}/retry`, {
    body: { requestId },
  });
}

/**
 * Allows or refuses the exact connector write a connector-write item stands
 * for (DEV-265). Allowing makes Foundry send it; refusing sends nothing.
 */
export function decidePendingItem(
  id: string,
  allow: boolean,
): Promise<unknown> {
  return request(
    "POST",
    `/api/pending-items/${encodeURIComponent(id)}/decide`,
    {
      body: { allow },
    },
  );
}
