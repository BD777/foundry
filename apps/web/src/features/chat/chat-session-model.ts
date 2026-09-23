import type {
  AgentProjection,
  AgentSession,
  ChatThread,
} from "@foundry/protocol";
import { runtimeMeta } from "../../components/ui/runtime-mark";
import {
  agentSessionIsAwaitingDetails,
  responseStreamLabel,
} from "../../lib/agent-session-events";
import type { ChatSessionThread } from "./chat-types";

export function agentSessionMessageText(
  session: AgentSession,
  context: { sessions?: AgentSession[] } = {},
): string {
  if (session.response) {
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
      return `等待本地 daemon 完成当前任务：${blockingSession.title}`;
    }
    return "已投递给本地 daemon，正在等待接收；daemon 重连或空闲后会自动重试。";
  }
  if (session.status === "running") {
    if (session.events === undefined) {
      return "Loading the persisted live transcript…";
    }
    return "Waiting for the local agent to stream a response.";
  }
  if (agentSessionIsAwaitingDetails(session)) {
    return "Loading response…";
  }
  return "No response yet.";
}

export function agentSessionTerminalError(
  session: AgentSession,
): string | undefined {
  if (session.error?.trim()) {
    return session.error.trim();
  }
  const failureEvent = [...(session.events ?? [])]
    .reverse()
    .find(
      (event) =>
        event.level === "error" &&
        (event.label === "执行失败" || event.label === "Session failed"),
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

export function isChatSession(session: AgentSession): boolean {
  return session.source === undefined || session.source === "chat";
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

export function nativeChatKey(
  provider?: string,
  nativeSessionId?: string,
): string {
  const normalizedProvider = provider?.trim();
  const normalizedSession = nativeSessionId?.trim();
  if (!normalizedProvider || !normalizedSession) {
    return "";
  }
  return `${normalizedProvider}\u0000${normalizedSession}`;
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

export function latestThreadSessionForAgent(
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
        isTerminalSession(session) &&
        session.nativeSessionId &&
        sessionMatchesAgentProfile(session, agent),
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
        sessionMatchesAgentProfile(session, agent) &&
        (session.status === "queued" || session.status === "running"),
    );
}

export function activeThreadSession(
  thread: ChatSessionThread | undefined,
): AgentSession | undefined {
  if (!thread) {
    return undefined;
  }
  return [...thread.sessions]
    .reverse()
    .find(
      (session) => session.status === "queued" || session.status === "running",
    );
}

export function isTerminalSession(session: AgentSession): boolean {
  return (
    session.status === "completed" ||
    session.status === "failed" ||
    session.status === "canceled"
  );
}

function transcriptLineForSession(session: AgentSession): string {
  const label = session.profileLabel ?? runtimeMeta(session.provider).label;
  const response = agentSessionMessageText(session);
  return [`User: ${session.prompt}`, response ? `${label}: ${response}` : ""]
    .filter(Boolean)
    .join("\n");
}

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
    return `从这里开始，Profile 从 ${profileLabelForSession(latest)} 切换为 ${targetLabel}。`;
  }
  if (input.selectedChat) {
    return `从这里开始，已从原生 ${profileLabelForChat(input.selectedChat)} 会话接入 ${targetLabel}。`;
  }
  return undefined;
}

export function importedContextForSend(input: {
  agent: AgentProjection;
  compatibleSession?: AgentSession;
  selectedChat?: ChatThread;
  thread?: ChatSessionThread;
}): string | undefined {
  const { agent, compatibleSession, selectedChat, thread } = input;
  if (thread) {
    const compatibleIndex = compatibleSession
      ? thread.sessions.findIndex(
          (session) => session.id === compatibleSession.id,
        )
      : -1;
    const delta = thread.sessions
      .slice(compatibleIndex + 1)
      .filter(
        (session) =>
          isTerminalSession(session) &&
          !sessionMatchesAgentProfile(session, agent),
      );
    if (delta.length > 0) {
      return delta.map(transcriptLineForSession).join("\n\n").slice(0, 12000);
    }
    return undefined;
  }
  if (selectedChat && !chatMatchesAgentProfile(selectedChat, agent)) {
    return [
      `Imported native chat: ${selectedChat.title}`,
      selectedChat.handoffContext ||
        (selectedChat.preview ? `Recap: ${selectedChat.preview}` : ""),
    ]
      .filter(Boolean)
      .join("\n");
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
        title: sorted[0]?.title ?? "Chat",
      };
    })
    .sort((left, right) => {
      const leftLatest = latestThreadSession(left)?.id ?? "";
      const rightLatest = latestThreadSession(right)?.id ?? "";
      return rightLatest.localeCompare(leftLatest);
    });
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
    return "Queued";
  }
  if (session.status === "running") {
    return "Streaming";
  }
  if (agentSessionTerminalError(session)) {
    return "Failed";
  }
  if (session.status === "completed") {
    return "Completed";
  }
  if (session.status === "failed") {
    return "Failed";
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
