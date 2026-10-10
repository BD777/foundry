import type { AgentSession } from "@bd777/foundry-protocol";

export interface ChatReadEntry {
  revision: string;
  forced?: boolean;
}
export type ChatReadState = Record<string, ChatReadEntry>;
export type ChatListStatus =
  "processing" | "blocked" | "failed" | "unread" | "idle";

export function chatIsUnread(
  entry: ChatReadEntry | undefined,
  answerRevision: string,
): boolean {
  return Boolean(
    entry?.forced || (answerRevision && entry?.revision !== answerRevision),
  );
}

/**
 * The chat the person is reading, or "" when none: the Chats view is shown,
 * a chat is open and the tab is visible. A new answer is marked read only
 * while this names its chat, so an answer that lands in a hidden tab stays
 * unread until the person comes back to it.
 */
export function chatReadView(input: {
  workspaceId: string;
  active: boolean;
  visible: boolean;
  selectedId: string;
}): string {
  return input.active && input.visible && input.selectedId
    ? `${input.workspaceId}:${input.selectedId}`
    : "";
}

export function chatListStatus(
  processing: boolean,
  failed: boolean,
  unread: boolean,
  blocked = false,
): ChatListStatus {
  if (blocked) return "blocked";
  return processing
    ? "processing"
    : failed
      ? "failed"
      : unread
        ? "unread"
        : "idle";
}

export function threadAnswerRevision(
  sessions: readonly AgentSession[],
): string {
  for (let index = sessions.length - 1; index >= 0; index--) {
    const session = sessions[index];
    if (session?.answerRevision) return session.answerRevision;
    if (session?.status === "completed" && session.response?.trim())
      return `${session.id}:${session.completedAt ?? ""}`;
  }
  return "";
}

export function loadChatReadState(workspaceId: string): ChatReadState {
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(`foundry.chatReadState.v1:${workspaceId}`) ??
        "{}",
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(
          ([, v]) =>
            v && typeof v === "object" && typeof v.revision === "string",
        )
        .map(([id, v]) => [
          id,
          { revision: v.revision, forced: v.forced === true },
        ]),
    );
  } catch {
    return {};
  }
}

export function saveChatReadState(
  workspaceId: string,
  state: ChatReadState,
): void {
  try {
    window.localStorage.setItem(
      `foundry.chatReadState.v1:${workspaceId}`,
      JSON.stringify(state),
    );
  } catch {
    /* Preferences must not block navigation. */
  }
}
