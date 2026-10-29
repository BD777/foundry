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
export function groupPendingItems(
  items: readonly PendingItem[],
  filter: PendingFilter,
  untitled: string,
): PendingGroup[] {
  const groups = new Map<string, PendingGroup>();
  for (const item of items) {
    if ((filter === "open") === pendingResolved(item)) continue;
    const key = item.issueId
      ? `issue:${item.issueId}`
      : `session:${item.sessionId ?? item.id}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        title: (item.issueId ? item.title : item.sessionTitle) || untitled,
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
