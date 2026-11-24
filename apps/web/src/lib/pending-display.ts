import type { TFunction } from "i18next";
import type {
  PendingHandler,
  PendingNoticeSkip,
  PendingNoticeStatus,
} from "../api/pending";

/*
 * What a needs-you item says it needs, the same wherever it is shown: the
 * needs-you page, a chat's bar, an assistant's home. Its headline is made
 * from the item's source and its own words (an account item's title is the
 * account's name, so its headline says what to do with it).
 */

/** The fields of a pending item its headline is made of. */
export interface PendingDisplayItem {
  source: string;
  rule?: string;
  title: string;
  excerpt: string;
  context?: string;
  eventId?: string;
}

/**
 * A request: an open item the person handles that asks something of them.
 * A notice is for their information only, so no count includes it: the
 * sidebar, the assistant's home, a chat's bar and its list badge, and the
 * tab title count the same requests.
 */
export function pendingRequest(item: {
  state: string;
  source: string;
  handler?: PendingHandler;
}): boolean {
  return (
    item.state === "open" &&
    item.handler !== "assistant" &&
    item.source !== "notice"
  );
}

/**
 * The one fact a request states about its Feishu card: sending, sent,
 * answered from the card, failed to send, or not sent and why. None for a
 * resolved item, an item without a notice, or a superseded card.
 */
export type PendingNoticeFact =
  | { key: "sending" | "sent" | "answered" | "failed" }
  | { key: "skipped"; reason: PendingNoticeSkip };

export function pendingNoticeFact(item: {
  state: string;
  notice?: PendingNoticeStatus;
}): PendingNoticeFact | undefined {
  if (item.state !== "open" || !item.notice) return undefined;
  const { state, skipped } = item.notice;
  if (skipped) return { key: "skipped", reason: skipped };
  switch (state) {
    case "queued":
    case "sending":
      return { key: "sending" };
    case "sent":
    case "answered":
    case "failed":
      return { key: state };
    default:
      return undefined;
  }
}

/** How far back the notice setting counts requests that were not sent. */
const unsentNoticeWindowMs = 7 * 24 * 60 * 60 * 1000;

/**
 * Open requests of the last 7 days that were not sent as a notice, by
 * reason, the most frequent first.
 */
export function unsentNotices(
  items: readonly {
    state: string;
    source: string;
    handler?: PendingHandler;
    createdAt: string;
    notice?: PendingNoticeStatus;
  }[],
  now = Date.now(),
): { count: number; reasons: { reason: PendingNoticeSkip; count: number }[] } {
  const byReason = new Map<PendingNoticeSkip, number>();
  let count = 0;
  for (const item of items) {
    const reason = item.notice?.skipped;
    if (!reason || !pendingRequest(item)) continue;
    const created = Date.parse(item.createdAt);
    if (Number.isNaN(created) || now - created > unsentNoticeWindowMs) continue;
    count += 1;
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  }
  const reasons = [...byReason]
    .map(([reason, reasonCount]) => ({ reason, count: reasonCount }))
    .sort((a, b) => b.count - a.count);
  return { count, reasons };
}

/**
 * The person's own items (DEV-125): an account or a device's sign-in, in no
 * workspace, chat or Issue; a failed bundle update; a message channel that
 * needs a look (DEV-203).
 */
export function pendingPersonal(item: PendingDisplayItem): boolean {
  return (
    item.source === "account" ||
    item.source === "connector" ||
    item.source === "bundle_update" ||
    item.source === "message_channel"
  );
}

/**
 * An account whose login lacks scopes the newer connector CLI Foundry runs
 * asks for (DEV-154): its context names that CLI version, its excerpt the
 * missing scopes.
 */
export function pendingScopeUpdate(item: PendingDisplayItem): boolean {
  return (
    item.source === "account" &&
    (item.eventId ?? "").startsWith("account-scopes:")
  );
}

/** Where a permission error was refused, as its output names it. */
/**
 * Whether full already says all of part: the same words, or part is full cut
 * short (the server cuts a long title or excerpt and ends it with "…"). An
 * item keeps one text in several fields (a hand-over's note, title and
 * excerpt); the page shows such a text once.
 */
export function textContains(full: string, part: string): boolean {
  const whole = full.replace(/\s+/g, " ").trim();
  const piece = part.replace(/\s+/g, " ").trim();
  if (!piece) return true;
  if (whole === piece) return true;
  const cut = piece.endsWith("…") ? piece.slice(0, -1).trimEnd() : "";
  return cut !== "" && whole.startsWith(cut);
}

const deniedPath =
  /(?:EACCES: permission denied, \w+ |\[Errno 13\] Permission denied: )'([^']+)'|^[\w.-]+: (?:cannot [a-z ]+? )?'?(\/[^':]+)'?: Permission denied$/m;

/**
 * What an item shows as its one line, and whether its excerpt adds anything
 * beyond it: a one-line question or error is the headline itself, so it is
 * shown once. A permission error names its path ("Permission denied: <path>",
 * `pathDenied`); an Issue's question is headed by the Issue.
 */
export function pendingHeadline(item: PendingDisplayItem): {
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

export function pendingFailure(
  item: PendingDisplayItem,
): PendingFailure | undefined {
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
 * The item's one-line headline: what it asks or what to do, never just the
 * name of what it concerns.
 */
export function pendingTitle(
  item: PendingDisplayItem,
  t: TFunction<"pending">,
): string {
  if (pendingScopeUpdate(item))
    return t("item.accountScopes", {
      title: item.title,
      version: item.context ?? "",
      count: item.excerpt.split(" ").filter(Boolean).length,
    });
  if (item.source === "bundle_update")
    return t(
      item.rule === "failed" ? "item.bundleFailed" : "item.bundleRolledBack",
      { title: item.title },
    );
  if (item.source === "account")
    return t("item.accountReauth", { title: item.title });
  if (item.source === "connector")
    return t("item.connectorExpired", { title: item.title });
  if (pendingPersonal(item)) return item.title;
  const failure = pendingFailure(item);
  if (failure && failure.kind !== "other")
    return t(`failure.${failure.kind}.title`);
  const headline = pendingHeadline(item);
  return headline.pathDenied
    ? t("item.permissionDenied", { path: headline.pathDenied })
    : headline.text;
}
