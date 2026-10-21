// The person's list (docs/personal-agent.md §6): what they told their
// assistant they plan to do, are doing or have done, in their own words.
// Kept by the server beside the assistant's own tasks; the assistant writes
// it (update_list), the person ticks, edits and deletes items on the
// assistant's home page. Same JSON names as
// apps/server/internal/store/personal_agent_list.go.

/** "done" and "dropped" are closed; closedAt says when. */
export type PersonalAgentListItemStatus = "open" | "done" | "dropped";

/** One thing on the person's list (table pa_items). */
export interface PersonalAgentListItem {
  id: string;
  intentRevision?: number;
  revision?: number;
  sourceInputId?: string;
  sourceInboxId?: string;
  plan?: PersonalAgentItemPlan;
  /** The thing, short, in the person's language. */
  text: string;
  /** When it happens, in the person's words ("after work", "下午"). */
  when?: string;
  /** `when` as a time (RFC 3339), only when it is known. */
  at?: string;
  /** Foundry reminds the person at `at` while the item is open. */
  remind: boolean;
  status: PersonalAgentListItemStatus;
  /** The person's words the item rests on. */
  quote?: string;
  /** The assistant's task helping with it (PersonalAgentTask.id). */
  taskId?: string;
  sourceSessionId?: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  /** When the reminder for `at` went out. */
  remindedAt?: string;
}

/**
 * The person's edit (PUT /api/personal-agent/list/{id}); absent fields
 * stay. Changing `when` clears `at` and the reminder: the time no longer
 * matches their words.
 */
export interface PersonalAgentListItemInput {
  revision?: number;
  plan?: PersonalAgentItemPlan;
  text?: string;
  when?: string;
  status?: PersonalAgentListItemStatus;
}

export interface PersonalAgentItemPlan {
  route?: PersonalAgentRouteDecision;
  mode: string;
  progress: string;
  nextAction?: string;
  waitingFor?: string;
  workspaceId?: string;
  dependencies?: string[];
  workRefs?: PersonalAgentWorkReference[];
  evidence?: PersonalAgentCompletionEvidence[];
}

export interface PersonalAgentWorkReference {
  kind: string;
  id: string;
  workspaceId: string;
  relation: string;
}

export interface PersonalAgentCompletionEvidence {
  kind: string;
  ref: string;
  summary: string;
  observedAt: string;
}

export interface PersonalAgentRouteDecision {
  kind: "record" | "continue" | "existing" | "create" | "multiple" | "clarify";
  reason: string;
  alternatives?: string[];
  needsClarification: boolean;
}
