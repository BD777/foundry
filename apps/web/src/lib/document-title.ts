import { i18n } from "../i18n";

/**
 * The browser tab: its title, most specific first so a narrow tab still
 * shows what it is ("<chat or page> · <workspace> — Foundry"), and its icon.
 * The app shell sets the page; the chat view adds the open chat and its
 * state. Other chats' unread answers stay the Chats list's blue dots.
 *
 * The open chat's state, most important first, marks both the title and
 * the icon (a status dot, for tabs too narrow for the title): it waits on
 * child sessions; its own turn runs; its finished answer is unseen (it
 * finished while this tab was hidden; seeing it clears the mark); its turn
 * ended but its agent still works in the background. Idle shows neither; a
 * chat whose agent only holds timers is idle too (it waits, often for days):
 * the chat's "scheduled · next at" note and its list row's clock say it will
 * wake.
 */
export const appName = "Foundry";

const maxPrimaryLength = 60;

export type TabStatus =
  "waiting" | "running" | "unread" | "background" | "idle";

/**
 * Each state's title marker and icon (in public/, made by
 * scripts/generate-tab-status-icons.py; idle is the app icon itself).
 */
export const tabStatusMarks: Record<
  TabStatus,
  { marker: string; icon: string }
> = {
  waiting: { marker: "⌛", icon: "foundry-icon-running.png" },
  running: { marker: "⏳", icon: "foundry-icon-running.png" },
  unread: { marker: "✅", icon: "foundry-icon-unread.png" },
  background: { marker: "⚙️", icon: "foundry-icon-background.png" },
  idle: { marker: "", icon: "foundry-icon.png" },
};

export interface DocumentTitleParts {
  /** The open chat, issue or device, else the page name. */
  primary?: string;
  /** The workspace, or the section a detail page belongs to. */
  context?: string;
  /** The open chat's turn runs. */
  running?: boolean;
  /** The open chat's finished answer is unseen. */
  unread?: boolean;
  /**
   * The open chat's turn ended, but background tasks, subagents or a
   * timer's run go on.
   */
  background?: boolean;
  /** Direct sub-sessions that make the open chat wait. */
  waitingChildCount?: number;
}

export function tabStatus(parts: DocumentTitleParts): TabStatus {
  if (parts.waitingChildCount) return "waiting";
  if (parts.running) return "running";
  if (parts.unread) return "unread";
  if (parts.background) return "background";
  return "idle";
}

function truncate(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > maxPrimaryLength
    ? `${text.slice(0, maxPrimaryLength - 1).trimEnd()}…`
    : text;
}

export function buildDocumentTitle(parts: DocumentTitleParts): string {
  const primary = truncate(parts.primary ?? "");
  const context = parts.context?.trim() ?? "";
  if (!primary && !context) return appName;
  const label = [primary, context].filter(Boolean).join(" · ");
  const { marker } = tabStatusMarks[tabStatus(parts)];
  const waiting = parts.waitingChildCount
    ? `${i18n.t("chat:waitingChildren.tab", { count: parts.waitingChildCount })} · `
    : "";
  return `${marker ? `${marker} ` : ""}${waiting}${label} — ${appName}`;
}

let page: DocumentTitleParts = {};
let chat:
  | {
      title: string;
      running: boolean;
      background?: boolean;
      waitingChildCount?: number;
    }
  | undefined;
let unread = false;
/** The page's own icon (index.html) shows until a state is marked. */
let shownIcon: TabStatus = "idle";

/** Points the page's icon at the state's; only when the state changed. */
function applyIcon(status: TabStatus): void {
  if (status === shownIcon) return;
  const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  if (!link) return;
  shownIcon = status;
  link.setAttribute(
    "href",
    `${import.meta.env?.BASE_URL ?? "/"}${tabStatusMarks[status].icon}`,
  );
}

function apply(): void {
  if (typeof document === "undefined") return;
  const parts: DocumentTitleParts = {
    ...page,
    ...(chat
      ? {
          primary: chat.title,
          running: chat.running,
          background: chat.background,
          waitingChildCount: chat.waitingChildCount,
        }
      : {}),
    // Status marks belong to an open chat; other pages never carry them.
    unread: chat ? unread : false,
  };
  document.title = buildDocumentTitle(parts);
  applyIcon(tabStatus(parts));
}

/** The page the app shell shows. */
export function setDocumentPage(next: DocumentTitleParts): void {
  page = next;
  apply();
}

/** The chat the Chats view shows; undefined when none is open. */
export function setDocumentChat(
  next:
    | {
        title: string;
        running: boolean;
        background?: boolean;
        waitingChildCount?: number;
      }
    | undefined,
): void {
  chat = next;
  apply();
}

/** Whether the open chat's finished answer is still unseen. */
export function setDocumentUnread(next: boolean): void {
  if (unread === next) return;
  unread = next;
  apply();
}
