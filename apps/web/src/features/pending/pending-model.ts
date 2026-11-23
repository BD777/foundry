import type { TFunction } from "i18next";
import {
  agentQuestionReplyText,
  nativeQuestionItemId,
} from "@bd777/foundry-protocol";
import type { PendingItem } from "../../api";
import type { PendingState } from "../../api/pending";
import { pendingNoticeFact, pendingPersonal } from "../../lib/pending-display";
import { clockTime } from "../../lib/time-format";

export {
  pendingFailure,
  pendingHeadline,
  pendingPersonal,
  pendingRequest,
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
  const assistant = pendingAssistantOf(item);
  return assistant ? `assistant:${assistant.id}` : "none";
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
  const assistant = pendingAssistantOf(item);
  if (assistant) {
    return { kind: "assistant", name: assistant.name || defaultAssistant };
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
 * The assistant an item comes from: the one whose own conversation it is in,
 * else the one it belongs to. A conversation's title is only its first
 * message, so it never names an assistant's item.
 */
function pendingAssistantOf(
  item: PendingItem,
): { id: string; name: string } | undefined {
  if (item.conversationAssistant) return item.conversationAssistant;
  if (item.assistantId)
    return { id: item.assistantId, name: item.assistantName ?? "" };
  return undefined;
}

/**
 * The items a filter shows, grouped by the chat or Issue they belong to:
 * groups ordered by their newest item, items newest first. Notices, for the
 * person's information, form one group of their own after the requests.
 */
export function groupPendingItems(
  items: readonly PendingItem[],
  filter: PendingFilter,
  untitled: string,
  personal = untitled,
  defaultAssistant = untitled,
  notices = untitled,
  itemLabel: (text: string) => string = (text) => text || untitled,
): PendingGroup[] {
  const groups = new Map<string, PendingGroup>();
  for (const item of items) {
    if ((filter === "open") === pendingResolved(item)) continue;
    if (pendingByAssistant(item)) continue;
    const notice = item.source === "notice";
    const own = pendingPersonal(item);
    // Saved messages and connector writes group under the assistant they
    // belong to, not a chat chosen among them (their attempts may run in
    // several chats; a write waits for the person, not a chat).
    const assistantOwn =
      item.source === "assistant_inbox" || item.source === "connector_write";
    // An item waiting on the person belongs to that item, not a chat; so
    // does what the assistant's own conversation asks about an item.
    const waitingItem =
      item.source === "item_wait" ||
      Boolean(!assistantOwn && item.conversationAssistant && item.itemId);
    // The rest of the assistant's own conversation groups under the
    // assistant too: the conversation's title is only its first message.
    const inbox =
      assistantOwn || (!waitingItem && Boolean(item.conversationAssistant));
    const assistant = pendingAssistantOf(item);
    const key = notice
      ? noticeGroupKey
      : waitingItem
        ? `item:${item.itemId || item.id}`
        : inbox
          ? `assistant:${assistant?.id || item.id}`
          : own
            ? "personal"
            : item.issueId
              ? `issue:${item.issueId}`
              : `session:${item.sessionId ?? item.id}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        title: notice
          ? notices
          : waitingItem
            ? itemLabel(item.itemText ?? "")
            : inbox
              ? assistant?.name || defaultAssistant
              : own
                ? personal
                : (item.issueId ? item.title : item.sessionTitle) || untitled,
        workspaceId: notice ? "" : item.workspaceId,
        workspaceName: notice ? "" : (item.workspaceName ?? ""),
        sessionId:
          notice || inbox || waitingItem || item.issueId
            ? undefined
            : item.sessionId,
        issueId: notice ? undefined : item.issueId,
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
    .sort(
      (a, b) =>
        Number(a.key === noticeGroupKey) - Number(b.key === noticeGroupKey) ||
        newest(b) - newest(a),
    );
}

/** The one group notices form on the page. */
const noticeGroupKey = "notices";

/**
 * The message a reply sends to the chat. A question answers in the envelope
 * the chat's question card uses (DEV-292b), naming the question's message
 * the way the card does, so the reply answers that question. Any other item:
 * its own words quoted, so the Agent knows what it answers even after its
 * context was compacted, then the person's reply.
 */
/**
 * Where a reply to an item goes: an Issue's question, the assistant's own
 * question or an item that waits on the person (answered through the entry),
 * or the item's chat.
 */
export type PendingReplyRoute = "issue" | "answer" | "chat" | "none";

export function pendingReplyRoute(
  item: Pick<PendingItem, "source" | "issueId" | "eventId" | "sessionId">,
): PendingReplyRoute {
  if (item.source === "issue_question" && item.issueId && item.eventId)
    return "issue";
  if (item.source === "assistant_question" || item.source === "item_wait")
    return "answer";
  if (item.sessionId) return "chat";
  return "none";
}

/**
 * What the reply box says about where the reply goes, by the reply's real
 * route: the Issue's question, the assistant conversation that asked, whoever
 * follows a waiting item (recorded on its timeline), or the item's chat.
 */
export function pendingReplyHintKey(
  item: Pick<PendingItem, "source" | "issueId" | "eventId" | "sessionId">,
):
  | "item.issueReplyHint"
  | "item.assistantReplyHint"
  | "item.itemReplyHint"
  | "item.replyHint" {
  switch (pendingReplyRoute(item)) {
    case "issue":
      return "item.issueReplyHint";
    case "answer":
      return item.source === "item_wait"
        ? "item.itemReplyHint"
        : "item.assistantReplyHint";
    default:
      return "item.replyHint";
  }
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
 * Connectors for an account). A resolved item asks for nothing.
 */
export type PendingPrimary = "options" | "reply" | "open" | "none";

/**
 * Whether the person can answer an item from its card: through its chat, its
 * Issue, or its own answer route (an item waiting on them has no chat).
 */
export function pendingCanReply(
  item: Pick<PendingItem, "source" | "sessionId" | "issueId" | "eventId">,
): boolean {
  return (
    item.source === "item_wait" ||
    Boolean(item.sessionId || (item.issueId && item.eventId))
  );
}

export function pendingPrimary(item: PendingItem): PendingPrimary {
  if (pendingResolved(item)) return "none";
  // A saved message's actions are retry, not-process and its attempt.
  if (item.source === "assistant_inbox") return "none";
  // A note needs no answer: the person reads it and dismisses it (DEV-278).
  if (item.source === "notice") return "none";
  if (pendingPersonal(item)) return "open";
  const canReply = pendingCanReply(item);
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
 * What a request's fact line says about its Feishu card, in words; empty
 * when it says nothing (see pendingNoticeFact).
 */
export function pendingNoticeText(
  item: Pick<PendingItem, "state" | "notice">,
  t: TFunction<"pending">,
): string {
  const fact = pendingNoticeFact(item);
  if (!fact) return "";
  if (fact.key === "skipped")
    return t("item.notice.skipped", {
      reason: t(`item.noticeSkipped.${fact.reason}`),
    });
  return t(`item.notice.${fact.key}`);
}
