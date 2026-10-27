import type { ToastTone } from "../../components/ui/toast";
import { useEffect, useMemo, useState } from "react";
import type {
  AgentProjection,
  AgentSession,
  ChatAttachment,
  ChatThread,
  DeviceProjection,
} from "@bd777/foundry-protocol";
import {
  cancelAgentSession,
  createAgentSession,
  sendAgentSessionMessage,
} from "../../api";
import { moveRuntimeChoice } from "../../components/conversation/conversation-storage";
import type { ConversationSendOutcome } from "../../components/conversation/conversation-types";
import { runtimeMeta } from "../../components/ui/runtime-mark";
import { i18n } from "../../i18n";
import { deviceAwaitedBy } from "../../lib/device-wait";
import { isTerminalSession } from "../../lib/session-status";
import {
  activeThreadSession,
  activeThreadSessionForAgent,
  latestThreadSession,
} from "./chat-model";
import { sessionStillActive, toChatSendError } from "./chat-send-error";
import type { chatComposerChoices } from "./chat-session-model";
import type { ChatSessionThread } from "./chat-types";
import type { ChatAttachments } from "./use-chat-attachments";
import type { ChatOutbox } from "./use-chat-outbox";
import type { ChatFeatureEvent } from "./use-chat-feature";

function agentLabel(agent: Pick<AgentSession, "profileLabel" | "provider">) {
  return agent.profileLabel ?? runtimeMeta(agent.provider).label;
}

export interface UseChatSendInput {
  attachments: ChatAttachments;
  composerChoices: (
    agent: AgentProjection,
  ) => ReturnType<typeof chatComposerChoices>;
  /**
   * Offline, a message still goes: the server holds it until the device is
   * back. Steering or stopping a running session needs the device.
   */
  deviceOnline: boolean;
  /** Names the offline device a queued session waits for. */
  devices: readonly DeviceProjection[];
  emit: (event: ChatFeatureEvent) => Promise<void>;
  notify: (message: string, tone?: ToastTone) => Promise<void>;
  outbox: ChatOutbox;
  selectedAgent?: AgentProjection;
  selectedChat?: ChatThread;
  selectedChatId: string;
  selectedThread?: ChatSessionThread;
  sessions: AgentSession[];
  /** The composer's thread, whose draft and choices move to a new session. */
  threadKey: string;
  workspaceId: string;
}

/**
 * Sending, steering and stopping the selected chat's agent, and the session a
 * send started until the projected thread shows it.
 */
export function useChatSend({
  attachments,
  composerChoices,
  deviceOnline,
  devices,
  emit,
  notify,
  outbox,
  selectedAgent,
  selectedChat,
  selectedChatId,
  selectedThread,
  sessions,
  threadKey,
  workspaceId,
}: UseChatSendInput) {
  const [activeSessionOverride, setActiveSessionOverride] =
    useState<AgentSession>();
  const [respondingSessionId, setRespondingSessionId] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const activeSession = useMemo(() => {
    const liveSession = activeThreadSession(selectedThread);
    if (liveSession) {
      return liveSession;
    }
    if (!activeSessionOverride || isTerminalSession(activeSessionOverride)) {
      return undefined;
    }
    const selectedThreadId = selectedThread?.id ?? selectedChatId;
    return activeSessionOverride.threadId === selectedThreadId ||
      activeSessionOverride.id === selectedThreadId ||
      activeSessionOverride.nativeSessionId === selectedThreadId
      ? activeSessionOverride
      : undefined;
  }, [activeSessionOverride, selectedChatId, selectedThread]);

  useEffect(() => {
    if (!activeSessionOverride) {
      return;
    }
    const projected = sessions.find(
      (session) => session.id === activeSessionOverride.id,
    );
    if (projected && isTerminalSession(projected)) {
      setActiveSessionOverride(undefined);
    }
  }, [activeSessionOverride, sessions]);

  useEffect(() => {
    if (!respondingSessionId) {
      return;
    }
    const session = sessions.find((item) => item.id === respondingSessionId);
    if (!session || !isTerminalSession(session)) {
      return;
    }
    setRespondingSessionId("");
    void notify(
      session.status === "failed"
        ? i18n.t("chat:notices.agentFailed", { agent: agentLabel(session) })
        : "",
      "error",
    );
  }, [notify, respondingSessionId, sessions]);

  function targetSession(sessionId?: string): AgentSession | undefined {
    return (
      (sessionId
        ? sessions.find((session) => session.id === sessionId)
        : undefined) ??
      (sessionId === activeSessionOverride?.id
        ? activeSessionOverride
        : undefined) ??
      activeSession
    );
  }

  async function send(
    draft: string,
    queuedAttachments?: ChatAttachment[],
    options?: { idempotencyKey?: string },
  ): Promise<ConversationSendOutcome> {
    const prompt = draft.trim();
    const effectiveAttachments = queuedAttachments ?? attachments.attachments;
    if (!prompt && effectiveAttachments.length === 0) {
      await notify(i18n.t("chat:notices.emptyPrompt"));
      return false;
    }
    if (attachments.uploading) {
      await notify(i18n.t("chat:notices.uploading"));
      return false;
    }
    if (!workspaceId || !selectedAgent) {
      await notify(i18n.t("chat:notices.noAgent"));
      return false;
    }
    // An offline device's agents read as unavailable; the server checks the
    // agent when the device is back.
    if (deviceOnline && selectedAgent.status !== "healthy") {
      await notify(
        i18n.t("chat:notices.agentNotReady", {
          agent: agentLabel(selectedAgent),
        }),
      );
      return false;
    }

    try {
      setSubmitting(true);
      if (activeSession) {
        await notify(
          i18n.t("chat:notices.stillResponding", {
            agent: agentLabel(activeSession),
          }),
        );
        return false;
      }
      if (activeThreadSessionForAgent(selectedThread, selectedAgent)) {
        await notify(
          i18n.t("chat:notices.alreadyResponding", {
            agent: agentLabel(selectedAgent),
          }),
        );
        return false;
      }
      // An open Foundry chat is one session: the message continues it. An
      // open native chat is adopted by the new session; the server tells
      // each native session what it has not seen.
      const continuedSession = selectedThread
        ? latestThreadSession(selectedThread)
        : undefined;
      const chatForSend = selectedThread ? undefined : selectedChat;
      // One id for this message: its Idempotency-Key, its input id and its
      // outbox entry, which tells the composer once the transcript shows it.
      const clientId = options?.idempotencyKey ?? crypto.randomUUID();
      const message = {
        ...composerChoices(selectedAgent),
        attachments: effectiveAttachments,
        inputId: clientId,
        prompt,
      };
      let session: AgentSession;
      outbox.add({
        at: new Date().toISOString(),
        attachments: effectiveAttachments,
        id: clientId,
        sessionId: continuedSession?.id,
        state: "pending",
        text: prompt,
        threadId: selectedThread?.id,
      });
      try {
        session = continuedSession
          ? await sendAgentSessionMessage(
              continuedSession.id,
              // A turn that started meanwhile (a queued message went first)
              // must not take this one as a steer: it is queued instead.
              { ...message, requireIdle: true },
              clientId,
            )
          : await createAgentSession(
              {
                ...message,
                chatId: chatForSend?.id,
                source: "chat",
                workspaceId,
              },
              clientId,
            );
      } catch (reason) {
        outbox.remove(clientId);
        // The turn started meanwhile: the message waits for it to end.
        if (continuedSession && sessionStillActive(reason)) return "queue";
        // Surface a safe, specific cause in the composer Alert. Throwing lets
        // useConversationInput retain the draft/attachments and require an
        // explicit retry (no auto-replay); busy protection is in its finally.
        throw toChatSendError(reason);
      }
      // The message is persisted server-side from here on. View-sync failures
      // must not look like an unsent draft, or the user could replay a session
      // that was already created.
      outbox.accept(clientId, {
        inputId: session.input?.id,
        sessionId: session.id,
        threadId: session.threadId || session.nativeSessionId || session.id,
      });
      setActiveSessionOverride(session);
      setRespondingSessionId(session.id);
      // A new chat or an adopted native chat is now this session's thread;
      // its unsent draft, queued messages and runtime choice move with it.
      const sessionThreadKey = `${workspaceId}:${session.threadId || session.nativeSessionId || session.id}`;
      moveRuntimeChoice(threadKey, sessionThreadKey);
      if (!queuedAttachments) {
        attachments.removeSent(effectiveAttachments);
      }
      try {
        await emit({ session, type: "session.answered" });
        await emit({
          chatId: session.threadId ?? session.nativeSessionId ?? session.id,
          type: "chat.selected",
        });
        const awaitedDevice = deviceAwaitedBy(session, devices);
        await notify(
          awaitedDevice
            ? i18n.t("chat:notices.waitingForDevice", {
                device: awaitedDevice.label,
              })
            : i18n.t("chat:notices.responding", {
                agent: agentLabel(selectedAgent),
              }),
        );
      } catch {
        // Already persisted; a later snapshot/refresh projects the session.
      }
      return { threadKey: sessionThreadKey };
    } finally {
      setSubmitting(false);
    }
  }

  async function steer(
    draft: string,
    sessionId?: string,
    steeredAttachments: ChatAttachment[] = [],
  ): Promise<boolean> {
    if (!deviceOnline) {
      await notify(i18n.t("chat:notices.offlineSteer"));
      return false;
    }
    const message = draft.trim();
    if (!message && steeredAttachments.length === 0) {
      await notify(i18n.t("chat:notices.emptySteer"));
      return false;
    }
    const target = targetSession(sessionId);
    if (!target) {
      await notify(i18n.t("chat:notices.noSteerTarget"));
      return false;
    }
    try {
      await sendAgentSessionMessage(target.id, {
        prompt: message,
        attachments: steeredAttachments.length ? steeredAttachments : undefined,
      });
      // The steer reaches the transcript as the device's event.
      await notify(i18n.t("chat:notices.steered"));
      return true;
    } catch (error) {
      await notify(
        error instanceof Error
          ? error.message
          : i18n.t("chat:notices.steerFailed"),
        "error",
      );
      return false;
    }
  }

  async function cancel(sessionId?: string): Promise<void> {
    const target = targetSession(sessionId);
    if (!target) {
      await notify(i18n.t("chat:notices.noStopTarget"));
      return;
    }
    // A queued session is the server's to cancel; a running one, the device's.
    if (!deviceOnline && target.status !== "queued") {
      await notify(i18n.t("chat:notices.offlineStop"));
      return;
    }
    try {
      const session = await cancelAgentSession(target.id);
      setActiveSessionOverride(undefined);
      setRespondingSessionId("");
      await emit({ session, type: "session.answered" });
      await emit({
        chatId: session.threadId ?? session.nativeSessionId ?? session.id,
        type: "chat.selected",
      });
      await notify(i18n.t("chat:notices.stopped"));
    } catch (error) {
      await notify(
        error instanceof Error
          ? error.message
          : i18n.t("chat:notices.stopFailed"),
        "error",
      );
    }
  }

  return {
    activeSession,
    cancel,
    /** Forgets the session a send started, as when its chat was deleted. */
    clearActiveSession: () => setActiveSessionOverride(undefined),
    /** Forgets the sent session and its pending failure notice. */
    reset: () => {
      setActiveSessionOverride(undefined);
      setRespondingSessionId("");
    },
    send,
    steer,
    submitting,
  };
}
