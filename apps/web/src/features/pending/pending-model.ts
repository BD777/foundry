import type { TFunction } from "i18next";
import {
  agentQuestionReplyText,
  nativeQuestionItemId,
} from "@bd777/foundry-protocol";
import type { PendingItem } from "../../api";
import type { PendingState } from "../../api/pending";
import { pendingPersonal } from "../../lib/pending-display";
import { clockTime } from "../../lib/time-format";

export {
  pendingFailure,
  pendingHeadline,
  pendingPersonal,
  pendingScopeUpdate,
  pendingTitle,
  type PendingFailure,
  type PendingFailureKind,
} from "../../lib/pending-display";

/** The items one place holds: a chat, or an Issue. */
export interface PendingGroup {
  key: string;
  title: string;
  workspaceId: string;
  workspaceName: string;
  sessionId?: string;
  issueId?: string;
  items: PendingItem[];
}

export type PendingFilter = "open" | "resolved";
export type PendingAssistantFilter = "all" | "none" | `assistant:${string}`;

export function pendingAssistantFilter(
  item: PendingItem,
): Exclude<PendingAssistantFilter, "all"> {
  return item.assistantId ? `assistant:${item.assistantId}` : "none";
}

export function pendingMatchesAssistant(
  item: PendingItem,
  filter: PendingAssistantFilter,
): boolean {
  return filter === "all" || pendingAssistantFilter(item) === filter;
}

export function pendingResolved(item: PendingItem): boolean {
  return item.state !== "open";
}

/** An open item the person's assistant handles (§h): not the person's to do. */
export function pendingByAssistant(item: PendingItem): boolean {
  return item.state === "open" && item.handler === "assistant";
}

/**
 * The items a filter shows, grouped by the chat or Issue they belong to:
 * groups ordered by their newest item, items newest first.
 */
/** Where an item came from: the assistant, its chat, or its project. */
export interface PendingOrigin {
  kind: "assistant" | "chat" | "project" | "personal";
  name: string;
}

export function pendingOrigin(
  item: PendingItem,
  untitled: string,
  personal: string,
  defaultAssistant: string,
): PendingOrigin {
  if (item.assistantId) {
    return {
      kind: "assistant",
      name: item.assistantName || defaultAssistant,
    };
  }
  if (item.sessionTitle) {
    return { kind: "chat", name: item.sessionTitle };
  }
  if (item.workspaceName) {
    return { kind: "project", name: item.workspaceName };
  }
  if (pendingPersonal(item)) {
    return { kind: "personal", name: personal };
  }
  return { kind: "chat", name: untitled };
}

/**
 * Upkeep suggestions (DEV-256) belong to a project or to an assistant, never
 * to a chat: they group under that name, so no "untitled chat" header shows.
 */
function upkeepOwner(item: PendingItem): "project" | "memory" | undefined {
  if (item.source === "project_upkeep") return "project";
  if (item.source === "memory_upkeep") return "memory";
  return undefined;
}

export function groupPendingItems(
  items: readonly PendingItem[],
  filter: PendingFilter,
  untitled: string,
  personal = untitled,
  defaultAssistant = untitled,
  projectFallback = untitled,
): PendingGroup[] {
  const groups = new Map<string, PendingGroup>();
  for (const item of items) {
    if ((filter === "open") === pendingResolved(item)) continue;
    if (pendingByAssistant(item)) continue;
    const own = pendingPersonal(item);
    // Saved messages and connector writes group under the assistant they
    // belong to, not a chat chosen among them (their attempts may run in
    // several chats; a write waits for the person, not a chat).
    const inbox =
      item.source === "assistant_inbox" ||
      item.source === "connector_write" ||
      item.source === "notice";
    const owner = upkeepOwner(item);
    const key = inbox
      ? `assistant-inbox:${item.assistantId || item.id}`
      : own
        ? "personal"
        : owner === "project"
          ? `project:${item.workspaceId}`
          : owner === "memory"
            ? `memory:${item.assistantId || item.id}`
            : item.issueId
              ? `issue:${item.issueId}`
              : `session:${item.sessionId ?? item.id}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        title: inbox
          ? item.assistantName || defaultAssistant
          : own
            ? personal
            : owner === "project"
              ? item.workspaceName || projectFallback
              : owner === "memory"
                ? item.assistantName || defaultAssistant
                : (item.issueId ? item.title : item.sessionTitle) || untitled,
        workspaceId: item.workspaceId,
        // An upkeep group's header is its name already; no second project name.
        workspaceName: owner ? "" : (item.workspaceName ?? ""),
        sessionId: inbox || item.issueId ? undefined : item.sessionId,
        issueId: item.issueId,
        items: [],
      };
      groups.set(key, group);
    }
    group.items.push(item);
  }
  const newest = (group: PendingGroup) =>
    Math.max(...group.items.map((item) => Date.parse(item.updatedAt) || 0));
  return [...groups.values()]
    .map((group) => ({
      ...group,
      items: [...group.items].sort(
        (a, b) =>
          (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0),
      ),
    }))
    .sort((a, b) => newest(b) - newest(a));
}

/**
 * The message a reply sends to the chat. A question answers in the envelope
 * the chat's question card uses (DEV-292b), naming the question's message
 * the way the card does, so the reply answers that question. Any other item:
 * its own words quoted, so the Agent knows what it answers even after its
 * context was compacted, then the person's reply.
 */
/**
 * Where a reply to an item goes: an Issue's question, the assistant's own
 * question (answered through the item), or the item's chat.
 */
export type PendingReplyRoute = "issue" | "answer" | "chat" | "none";

export function pendingReplyRoute(
  item: Pick<PendingItem, "source" | "issueId" | "eventId" | "sessionId">,
): PendingReplyRoute {
  if (item.source === "issue_question" && item.issueId && item.eventId)
    return "issue";
  if (item.source === "assistant_question") return "answer";
  if (item.sessionId) return "chat";
  return "none";
}

/**
 * The item a notice's link opens: `/pending?item=<id>` (DEV-294). Empty when
 * the address names none.
 */
export function pendingFocusItemId(search: string): string {
  return new URLSearchParams(search).get("item") ?? "";
}

/** The DOM id of one item's card on the Pending page, where a link scrolls to. */
export function pendingItemDomId(itemId: string): string {
  return `pending-item-${itemId}`;
}

/** The i18n key of a resolved item's status: a withdrawn question says so. */
export function pendingStatusKey(
  item: Pick<PendingItem, "state" | "outcome">,
): "outcome.withdrawn" | `state.${PendingState}` {
  return item.outcome === "withdrawn"
    ? "outcome.withdrawn"
    : `state.${item.state}`;
}

/**
 * The approval's detail as the person reads it: the command or the changed
 * paths, without the Markdown fence lines and inline code marks around them.
 * Shown as plain text, never rendered as Markdown; empty for a non-approval.
 */
export function pendingApprovalDetail(
  item: Pick<PendingItem, "approval" | "detail">,
): string {
  if (!item.approval) return "";
  return (item.detail ?? "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("```"))
    .map((line) => line.replace(/`([^`]*)`/g, "$1"))
    .join("\n")
    .trim();
}

export function pendingReplyText(item: PendingItem, reply: string): string {
  const messageId = item.messageId;
  if (item.source === "question" && messageId && item.title.trim())
    return agentQuestionReplyText(
      nativeQuestionItemId(messageId),
      [{ title: item.title.trim() }],
      [reply],
    );
  const quoted = item.excerpt
    .trim()
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
  return `${quoted}\n\n${reply.trim()}`;
}

/** Items of one chat, open first. */
export function pendingForSession(
  items: readonly PendingItem[],
  sessionId: string,
): PendingItem[] {
  return items
    .filter(
      (item) =>
        item.sessionId === sessionId &&
        !item.issueId &&
        !pendingByAssistant(item),
    )
    .sort(
      (a, b) =>
        Number(pendingResolved(a)) - Number(pendingResolved(b)) ||
        (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0),
    );
}

/** Why an unprocessed assistant message waits: a bucket of the same fix. */
export type InboxWaitBucket =
  "device_offline" | "worker_update" | "account" | "paused" | "queued";

export function inboxWaitBucket(rule?: string): InboxWaitBucket {
  switch (rule) {
    case "device_offline":
      return "device_offline";
    case "worker_update_needed":
      return "worker_update";
    case "assistant_paused":
      return "paused";
    case "account_unavailable":
    case "role_disabled":
    case "model_unavailable":
    case "effort_unavailable":
    case "permission_required":
    case "location_mismatch":
      return "account";
    default:
      return "queued";
  }
}

/**
 * The one line an unprocessed assistant message says why it waits: its
 * failed attempt's classified reason (a quota's reset when it names one),
 * a stop, or what it is waiting for.
 */
export function pendingInboxReason(
  item: PendingItem,
  t: TFunction<"pending">,
  now = new Date(),
): string {
  if (item.failureCategory) {
    if (item.failureCategory === "quota_exhausted" && item.failureResetAt) {
      const reset = Date.parse(item.failureResetAt);
      if (!Number.isNaN(reset))
        return reset <= now.getTime()
          ? t("item.inboxReason.quotaReset")
          : t("item.inboxReason.quotaResets", {
              time: clockTime(item.failureResetAt, { date: "short" }),
            });
    }
    return t(`item.inboxReason.${item.failureCategory}`);
  }
  if (item.rule === "canceled") return t("item.inboxReason.canceled");
  return t(`item.inboxWait.${inboxWaitBucket(item.rule)}`);
}

/** An Agent's option without the "(Recommended)" it may have added itself. */
export function pendingOptionLabel(option: string): string {
  return (
    option.replace(/\s*[(（]\s*(recommended|推荐)\s*[)）]\s*$/i, "").trim() ||
    option
  );
}

/**
 * The one thing an item asks for, shown as its first action: answering with
 * one of the Agent's options, replying, or going where it can be done (the
 * chat for a failed turn, the message for a step only the person can take,
 * Connectors for an account, the device's GitHub permissions for a missing
 * GitHub scope). A resolved item asks for nothing.
 */
export type PendingPrimary = "options" | "reply" | "open" | "grant" | "none";

export function pendingPrimary(item: PendingItem): PendingPrimary {
  if (pendingResolved(item)) return "none";
  // A saved message's actions are retry, not-process and its attempt.
  if (item.source === "assistant_inbox") return "none";
  // A project's suggestions are decided on the project's page (DEV-256).
  if (item.source === "project_upkeep") return "none";
  if (item.source === "memory_upkeep") return "none";
  // A note needs no answer: the person reads it and dismisses it (DEV-278).
  if (item.source === "notice") return "none";
  if (pendingPersonal(item)) return "open";
  // A GitHub scope the session's device lacks (DEV-136): its picker there.
  if (item.rule === "github_scope" && item.deviceId) return "grant";
  const canReply = Boolean(item.sessionId || (item.issueId && item.eventId));
  if (item.options?.length && canReply) return "options";
  if (
    item.source === "turn_failed" ||
    item.source === "needs_hands" ||
    item.source === "helper_stuck"
  )
    return "open";
  return canReply ? "reply" : "open";
}

/**
 * The GitHub scopes a github_scope item asks the person to add (DEV-136):
 * named in gh's "missing required scopes [a, b]" or git's "without
 * `workflow` scope"; empty when the output named none.
 */
export function pendingGitHubScopes(item: PendingItem): string[] {
  if (item.source !== "needs_hands" || item.rule !== "github_scope") return [];
  const text = `${item.title}\n${item.excerpt}`;
  const listed = /missing required scopes? \[([^\]]+)\]/i.exec(text)?.[1];
  const scopes = listed
    ? listed.split(/[\s,]+/)
    : (/without `([a-z_:]+)` scope/i.exec(text)?.slice(1) ?? []);
  return [
    ...new Set(scopes.map((s) => s.trim()).filter((s) => /^[a-z_:]+$/.test(s))),
  ];
}
