import type { PendingItem } from "../../api";

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

export function pendingResolved(item: PendingItem): boolean {
  return item.state !== "open";
}

/**
 * The items a filter shows, grouped by the chat or Issue they belong to:
 * groups ordered by their newest item, items newest first.
 */
/**
 * The person's own items (DEV-125): an account or a device's sign-in, in no
 * workspace, chat or Issue.
 */
export function pendingPersonal(item: PendingItem): boolean {
  return item.source === "account" || item.source === "connector";
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
    .filter((item) => item.sessionId === sessionId && !item.issueId)
    .sort(
      (a, b) =>
        Number(pendingResolved(a)) - Number(pendingResolved(b)) ||
        (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0),
    );
}

/** Where a permission error was refused, as its output names it. */
const deniedPath =
  /(?:EACCES: permission denied, \w+ |\[Errno 13\] Permission denied: )'([^']+)'|^[\w.-]+: (?:cannot [a-z ]+? )?'?(\/[^':]+)'?: Permission denied$/m;

/**
 * What an item shows as its one line, and whether its excerpt adds anything
 * beyond it: a one-line question or error is the headline itself, so it is
 * shown once. A permission error names its path ("Permission denied: <path>",
 * `pathDenied`); an Issue's question is headed by the Issue.
 */
export function pendingHeadline(item: PendingItem): {
  text: string;
  pathDenied?: string;
  showExcerpt: boolean;
} {
  const excerpt = item.excerpt.trim();
  const singleLine = !excerpt.includes("\n");
  if (item.source === "issue_question")
    return { text: item.title, showExcerpt: excerpt !== item.title.trim() };
  if (item.source === "needs_hands" && item.rule === "permission") {
    const match = deniedPath.exec(excerpt);
    const path = match?.[1] ?? match?.[2];
    if (path)
      return {
        text: item.title,
        pathDenied: path,
        showExcerpt: !(singleLine && excerpt === item.title.trim()),
      };
  }
  const text = item.title.trim() || excerpt.split("\n")[0]!;
  return { text, showExcerpt: !(singleLine && excerpt === text) };
}

/** An Agent's option without the "(Recommended)" it may have added itself. */
export function pendingOptionLabel(option: string): string {
  return (
    option.replace(/\s*[(（]\s*(recommended|推荐)\s*[)）]\s*$/i, "").trim() ||
    option
  );
}

/**
 * What a failed turn needs from the person, read from its error so the item
 * leads with the fix instead of the raw text: a usage limit (and when it
 * resets), a chat started on another provider, a full disk, a run the device
 * interrupted, a turn that ran out of steps. `other` keeps the error's own
 * first line as the headline.
 */
export type PendingFailureKind =
  | "usage_limit"
  | "provider_mismatch"
  | "disk_full"
  | "interrupted"
  | "turn_limit"
  | "other";

export interface PendingFailure {
  kind: PendingFailureKind;
  /** When a usage limit resets, in the provider's words. */
  resets?: string;
  /** The provider the chat was started on, and the one selected now. */
  chatProvider?: string;
  currentProvider?: string;
}

const usageLimit =
  /\b(?:hit|reached|exceeded) (?:your |the )?(?:[\w-]+ )?(?:usage |rate )?limit\b|\busage limit\b|\brate[ _-]?limit|user tpm rate limit exceeded|throttle by model gateway|\bquota exceeded\b/i;
const limitResets = /\bresets?\s+(?:at\s+|on\s+)?([^\n]+?)[\s.]*$/im;
const providerMismatch =
  /\bThis chat uses ([\w.:/-]+), but your current provider is ([\w.:/-]+?)\.?(?:\s|$)/;

export function pendingFailure(item: PendingItem): PendingFailure | undefined {
  if (item.source !== "turn_failed") return undefined;
  const error = `${item.title}\n${item.excerpt}`;
  const mismatch = providerMismatch.exec(error);
  if (mismatch)
    return {
      kind: "provider_mismatch",
      chatProvider: mismatch[1],
      currentProvider: mismatch[2],
    };
  if (usageLimit.test(error)) {
    const resets = limitResets.exec(error)?.[1]?.trim();
    return resets ? { kind: "usage_limit", resets } : { kind: "usage_limit" };
  }
  if (/\bENOSPC\b|\bno space left on device\b/i.test(error))
    return { kind: "disk_full" };
  if (/\bexecution host stopped\b/i.test(error)) return { kind: "interrupted" };
  if (/maximum number of turns/i.test(error)) return { kind: "turn_limit" };
  return { kind: "other" };
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
  if (item.source === "turn_failed" || item.source === "needs_hands")
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
