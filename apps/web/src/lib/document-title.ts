/**
 * The browser tab title, most specific first so a narrow tab still shows
 * what it is: "<chat or page> · <workspace> — Foundry". The app shell sets
 * the page; the chat view adds the open chat and whether it is running.
 */
export const appName = "Foundry";

const maxPrimaryLength = 60;

export interface DocumentTitleParts {
  /** The open chat, issue or device, else the page name. */
  primary?: string;
  /** The workspace, or the section a detail page belongs to. */
  context?: string;
  /** The chat shown is running; marked with a leading "●". */
  running?: boolean;
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
  return `${parts.running ? "● " : ""}${label} — ${appName}`;
}

let page: DocumentTitleParts = {};
let chat: { title: string; running: boolean } | undefined;

function apply(): void {
  if (typeof document === "undefined") return;
  document.title = buildDocumentTitle(
    chat ? { ...page, primary: chat.title, running: chat.running } : page,
  );
}

/** The page the app shell shows. */
export function setDocumentPage(next: DocumentTitleParts): void {
  page = next;
  apply();
}

/** The chat the Chats view shows; undefined when none is open. */
export function setDocumentChat(
  next: { title: string; running: boolean } | undefined,
): void {
  chat = next;
  apply();
}
