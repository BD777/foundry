import type { PendingItem } from "../../api";
import { pendingPersonal } from "../../lib/pending-display";

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

export function groupPendingItems(
  items: readonly PendingItem[],
  filter: PendingFilter,
  untitled: string,
  personal = untitled,
): PendingGroup[] {
  const groups = new Map<string, PendingGroup>();
  for (const item of items) {
    if ((filter === "open") === pendingResolved(item)) continue;
    if (pendingByAssistant(item)) continue;
    const own = pendingPersonal(item);
    const key = own
      ? "personal"
      : item.issueId
        ? `issue:${item.issueId}`
        : `session:${item.sessionId ?? item.id}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        title: own
          ? personal
          : (item.issueId ? item.title : item.sessionTitle) || untitled,
        workspaceId: item.workspaceId,
        workspaceName: item.workspaceName ?? "",
        sessionId: item.issueId ? undefined : item.sessionId,
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
 * The message a reply sends to the chat: the item's own words quoted, so
 * the Agent knows what it answers even after its context was compacted,
 * then the person's reply.
 */
export function pendingReplyText(item: PendingItem, reply: string): string {
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
