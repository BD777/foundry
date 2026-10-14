import {
  sessionInputEventLabel,
  type AgentProjection,
  type AgentSession,
  type ChatThread,
} from "@bd777/foundry-protocol";
import { runtimeMeta } from "../../components/ui/runtime-mark";
import { i18n } from "../../i18n";
import { isProcessLabel } from "../../lib/process-labels";
import { isSessionLive } from "../../lib/session-status";
import {
  agentSessionIsAwaitingDetails,
  responseStreamLabel,
} from "../../lib/agent-session-events";
import type { ChatSessionThread } from "./chat-types";
import type { CreateAgentSessionInput } from "../../api-types";

export function agentSessionMessageText(
  session: AgentSession,
  context: { sessions?: AgentSession[] } = {},
): string {
  // While a turn runs, the response is still the previous turn's answer.
  if (session.response && !isSessionLive(session)) {
    return session.response;
  }
  if (session.error) {
    return session.error;
  }
  const latestResponseEvent = [...(session.events ?? [])]
    .reverse()
    .find(
      (event) =>
        event.label === responseStreamLabel && event.detail.trim() !== "",
    );
  if (latestResponseEvent) {
    return latestResponseEvent.detail;
  }
  if (session.status === "queued") {
    const blockingSession = (context.sessions ?? []).find(
      (candidate) =>
        candidate.id !== session.id &&
        candidate.deviceId === session.deviceId &&
        candidate.status === "running",
    );
    if (blockingSession) {
      return i18n.t("chat:session.waitingForTask", {
        title: blockingSession.title,
      });
    }
    return i18n.t("chat:session.delivered");
  }
  if (session.status === "running") {
    if (session.events === undefined) {
      return i18n.t("chat:session.loadingTranscript");
    }
    return i18n.t("chat:session.waitingForResponse");
  }
  if (agentSessionIsAwaitingDetails(session)) {
    return i18n.t("chat:session.loadingResponse");
  }
  return i18n.t("chat:session.noResponse");
}

export function agentSessionTerminalError(
  session: AgentSession,
): string | undefined {
  if (session.error?.trim()) {
    return session.error.trim();
  }
  // Only the latest turn's failure ends the session; an earlier turn's stays
  // in that turn's transcript once the person has sent another message.
  const newestFirst = [...(session.events ?? [])].reverse();
  const nextInput = newestFirst.findIndex(
    (event) => event.label === sessionInputEventLabel,
  );
  const failureEvent = newestFirst
    .slice(0, nextInput < 0 ? undefined : nextInput)
    .find(
      (event) =>
        event.level === "error" && isProcessLabel(event.label, "sessionFailed"),
    );
  return failureEvent?.detail.trim() || undefined;
}

export function agentSessionHasStreamedResponse(
  session: AgentSession,
): boolean {
  return (session.events ?? []).some(
    (event) =>
      event.label === responseStreamLabel && event.detail.trim() !== "",
  );
}

/**
 * Whether Chats lists the session: the one rule for what the person finds
 * there. Everything their agents start is listed, so nothing an agent did
 * on their behalf is out of sight; what is left out is listed where it
 * belongs.
 *
 * - chat (or none, older rows): the person's own chats, forks they made
 *   included. A timer's wake or a background continuation is a new input
 *   of the same session, never another session, so it stays that chat's row.
 * - agent: a session another session started (create_session, a fork, a
 *   handoff by an agent). Listed in the starting session's group, and the
 *   person may open and continue it.
 * - verification: a verifier an agent started. Listed like any child; it
 *   stays read-only in its sandbox when the person continues it.
 * - agent or verification inside an Issue (issueId): it works in the
 *   Issue's candidate, gets no Chats group and is listed on its Issue.
 * - issue: an Issue's execution or clarification; listed on its Issue.
 * - naming, diagnostic, digest: Foundry's own jobs (titles, group names,
 *   checks, the assistant's project summaries), not work anyone asked for.
 *
 * Any of them still opens by id (a link, the Issue page), read-only when
 * not listed.
 */
export function isChatSession(session: AgentSession): boolean {
  const source = session.source;
  switch (source) {
    case undefined:
    case "chat":
      return true;
    case "agent":
    case "verification":
      return !session.issueId;
    case "issue":
    case "naming":
    case "diagnostic":
    case "digest":
      return false;
    default: {
      // A new source does not compile until it is decided here.
      const undecided: never = source;
      void undecided;
      return false;
    }
  }
}

/**
 * Whether the server keeps a message queue for the thread: a person's own
 * chat, or a device's native chat (no session of that id). Sessions an
 * agent started, Issue sessions and the assistant's (any role) are listed
 * or opened here but have none; asking for it answers 404
 * (httpapi/chat_queue.go chatQueueChat).
 */
export function chatHasQueue(
  threadId: string,
  sessions: readonly AgentSession[],
): boolean {
  const session = sessions.find((row) => row.id === threadId);
  return (
    !session ||
    (!session.role &&
      (session.source === undefined || session.source === "chat"))
  );
}

function chatThreadId(session: AgentSession): string {
  return session.threadId || session.nativeSessionId || session.id;
}

function compareSessionsAscending(a: AgentSession, b: AgentSession): number {
  return a.id.localeCompare(b.id);
}

export function latestThreadSession(
  thread: ChatSessionThread,
): AgentSession | undefined {
  return thread.sessions[thread.sessions.length - 1];
}

export function chatMatchesAgentProfile(
  chat: ChatThread | undefined,
  agent: AgentProjection | undefined,
): boolean {
  if (!chat || !agent || chat.provider !== agent.provider) {
    return false;
  }
  if (chat.profileId && agent.profileId && chat.profileId === agent.profileId) {
    return true;
  }
  if (
    chat.profileFingerprint &&
    agent.profileFingerprint &&
    chat.profileFingerprint === agent.profileFingerprint
  ) {
    return true;
  }
  return (
    !chat.profileId &&
    !chat.profileFingerprint &&
    !agent.profileId &&
    !agent.profileFingerprint
  );
}

function sessionMatchesAgentProfile(
  session: AgentSession | undefined,
  agent: AgentProjection | undefined,
): boolean {
  if (!session || !agent || session.provider !== agent.provider) {
    return false;
  }
  if (
    session.profileId &&
    agent.profileId &&
    session.profileId === agent.profileId
  ) {
    return true;
  }
  if (
    session.profileFingerprint &&
    agent.profileFingerprint &&
    session.profileFingerprint === agent.profileFingerprint
  ) {
    return true;
  }
  return (
    !session.profileId &&
    !session.profileFingerprint &&
    !agent.profileId &&
    !agent.profileFingerprint
  );
}

export function activeThreadSessionForAgent(
  thread: ChatSessionThread | undefined,
  agent: AgentProjection | undefined,
): AgentSession | undefined {
  if (!thread || !agent) {
    return undefined;
  }
  return [...thread.sessions]
    .reverse()
    .find(
      (session) =>
        sessionMatchesAgentProfile(session, agent) && isSessionLive(session),
    );
}

export function activeThreadSession(
  thread: ChatSessionThread | undefined,
): AgentSession | undefined {
  if (!thread) {
    return undefined;
  }
  return [...thread.sessions].reverse().find(isSessionLive);
}

/**
 * The conversation so far as plain text, for a runtime that cannot resume the
 * session's native transcript. The tail is kept when it is long.
 */
function profileLabelForAgent(agent: AgentProjection): string {
  return agent.profileLabel ?? runtimeMeta(agent.provider).label;
}

function profileLabelForSession(session: AgentSession): string {
  return session.profileLabel ?? runtimeMeta(session.provider).label;
}

function profileLabelForChat(chat: ChatThread): string {
  return (
    chat.profileLabel ??
    (chat.provider ? runtimeMeta(chat.provider).label : "native session")
  );
}

export function profileTransitionNoteForSend(input: {
  agent: AgentProjection;
  selectedChat?: ChatThread;
  thread?: ChatSessionThread;
}): string | undefined {
  const targetLabel = profileLabelForAgent(input.agent);
  if (input.thread) {
    const latest = latestThreadSession(input.thread);
    if (!latest || sessionMatchesAgentProfile(latest, input.agent)) {
      return undefined;
    }
    return i18n.t("chat:session.profileSwitched", {
      from: profileLabelForSession(latest),
      to: targetLabel,
    });
  }
  if (input.selectedChat) {
    return i18n.t("chat:session.nativeImported", {
      from: profileLabelForChat(input.selectedChat),
      to: targetLabel,
    });
  }
  return undefined;
}

export function chatThreadsFromSessions(
  sessions: AgentSession[],
): ChatSessionThread[] {
  const groups = new Map<string, AgentSession[]>();
  for (const session of sessions) {
    const id = chatThreadId(session);
    groups.set(id, [...(groups.get(id) ?? []), session]);
  }

  return [...groups.entries()]
    .map(([id, threadSessions]) => {
      const sorted = [...threadSessions].sort(compareSessionsAscending);
      return {
        id,
        sessions: sorted,
        title: sorted[0]?.title ?? i18n.t("chat:session.defaultTitle"),
      };
    })
    .sort((left, right) => {
      const leftLatest = latestThreadSession(left)?.id ?? "";
      const rightLatest = latestThreadSession(right)?.id ?? "";
      return rightLatest.localeCompare(leftLatest);
    });
}

/**
 * The list row's note of who started a chat another session started: the
 * starting chat's title as the list shows it (`titleOf`), or "another
 * session" when the list does not hold it. Undefined for the person's own.
 */
export function chatStartedByLabel(
  session: AgentSession | undefined,
  threads: readonly ChatSessionThread[],
  titleOf: (thread: ChatSessionThread) => string,
): string | undefined {
  const parentId = session?.parentSessionId;
  if (!parentId) return undefined;
  const parent = threads.find((thread) =>
    thread.sessions.some((candidate) => candidate.id === parentId),
  );
  const title = parent
    ? titleOf(parent)
    : i18n.t("chat:listRow.anotherSession");
  return session.source === "verification"
    ? i18n.t("chat:listRow.verifierStartedBy", { title })
    : i18n.t("chat:listRow.startedBy", { title });
}

/** A session of the list is the chat `id` names, or belongs to it. */
export function sessionsHoldChat(
  sessions: readonly AgentSession[],
  id: string,
): boolean {
  return sessions.some(
    (session) => session.id === id || chatThreadId(session) === id,
  );
}

export function selectedChatThread(
  threads: ChatSessionThread[],
  selectedId: string,
): ChatSessionThread | undefined {
  return threads.find(
    (thread) =>
      thread.id === selectedId ||
      thread.sessions.some((session) => session.id === selectedId),
  );
}

export function agentSessionStatusLabel(session: AgentSession): string {
  if (session.status === "queued") {
    return i18n.t("chat:session.status.queued");
  }
  if (session.status === "running") {
    return i18n.t("chat:session.status.streaming");
  }
  if (agentSessionTerminalError(session)) {
    return i18n.t("chat:session.status.failed");
  }
  if (session.status === "completed") {
    return i18n.t("chat:session.status.completed");
  }
  if (session.status === "failed") {
    return i18n.t("chat:session.status.failed");
  }
  return session.status;
}

export function chatSortValue(chat: ChatThread): number {
  void chat;
  return 0;
}

export function preferredChatId(chats: ChatThread[]): string {
  return chats[0]?.id ?? "";
}

/** The composer's runtime controls a message is sent with. */
export type ChatComposerControls = Pick<
  CreateAgentSessionInput,
  | "claudePermissionMode"
  | "codexApprovalPolicy"
  | "codexSandboxMode"
  | "codexSpeed"
  | "model"
> & {
  /** Empty: the model's default. */
  claudeEffort?: CreateAgentSessionInput["claudeEffort"] | "";
  codexReasoningEffort?: CreateAgentSessionInput["codexReasoningEffort"] | "";
};

/**
 * What a message is sent with: the agent and the controls of its runtime.
 * A message queued now keeps them until the server sends it.
 */
export function chatComposerChoices(
  agent: AgentProjection,
  controls: ChatComposerControls,
  conversation: { selectedChat?: ChatThread; thread?: ChatSessionThread },
) {
  const claude = agent.provider === "claude";
  const codex = agent.provider === "codex";
  return {
    agentId: agent.id,
    claudeEffort: (claude && controls.claudeEffort) || undefined,
    claudePermissionMode: claude ? controls.claudePermissionMode : undefined,
    codexApprovalPolicy: codex ? controls.codexApprovalPolicy : undefined,
    codexReasoningEffort: (codex && controls.codexReasoningEffort) || undefined,
    codexSandboxMode: codex ? controls.codexSandboxMode : undefined,
    codexSpeed: codex ? controls.codexSpeed : undefined,
    model: controls.model || undefined,
    profileId: agent.profileId,
    profileTransitionNote: profileTransitionNoteForSend({
      agent,
      selectedChat: conversation.thread ? undefined : conversation.selectedChat,
      thread: conversation.thread,
    }),
    provider: agent.provider,
  };
}
