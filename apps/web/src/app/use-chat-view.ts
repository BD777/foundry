import type { ToastTone } from "../components/ui/toast";
import { createElement, useMemo, type ReactElement } from "react";
import { useChatFeature, type ChatFeatureEvent } from "../features/chat";
import { PendingChatButton, type PendingItems } from "../features/pending";
import { workspaceComposerSkills } from "./composer-skills";
import {
  useRemovedChatSelection,
  withSessionDetails,
} from "./loaded-foundry-data";
import type { AppLocation } from "./use-app-location";
import type { CurrentWorkspace } from "./use-current-workspace";
import type { WorkspaceData } from "./use-workspace-data";

export interface UseChatViewInput {
  current: CurrentWorkspace;
  draftFromSource: (source: string) => void;
  location: AppLocation;
  setNotice: (message: string, tone?: ToastTone) => void;
  workspaceData: WorkspaceData;
  /** The person's pending items: each chat's count and its header button. */
  pending: PendingItems;
}

/**
 * The Chats page. The chat feature lives for the whole app (its sessions
 * keep streaming while another page shows); the shell keeps the selected
 * chat and applies what the feature answered to the shared data.
 */
export function useChatView({
  current,
  draftFromSource,
  location: {
    activeView,
    chatView,
    selectedChatId,
    setSelectedChatId,
    selectChat,
  },
  setNotice,
  pending,
  workspaceData: { apiState, applyAnswered, data, setData },
}: UseChatViewInput): ReactElement {
  async function handleChatFeatureEvent(
    event: ChatFeatureEvent,
  ): Promise<void> {
    if (event.type === "chat.selected") {
      selectChat(event.chatId);
      return;
    }
    if (event.type === "notice.requested") {
      setNotice(event.message, event.tone);
      return;
    }
    if (event.type === "issue.draft.requested") {
      draftFromSource(event.source);
      return;
    }
    if (event.type === "session.answered") {
      // A turn that ended may have asked, failed or answered something.
      pending.refresh();
      applyAnswered({
        type: "agent_session_created",
        payload: event.session,
      });
      return;
    }
    setData((shown) =>
      withSessionDetails(shown, event.workspaceId, event.sessions),
    );
  }

  const slashSkills = useMemo(() => workspaceComposerSkills(data), [data]);

  useRemovedChatSelection(data, selectedChatId, setSelectedChatId);
  const threadHeaderAction = selectedChatId
    ? createElement(PendingChatButton, { pending, sessionId: selectedChatId })
    : undefined;

  return useChatFeature({
    active: activeView === "chats",
    archivedView: chatView === "archived",
    agents: current.agents,
    nativeChats: data.chats,
    device: current.device,
    deviceOnline: current.deviceOnline,
    devices: data.devices,
    onEvent: handleChatFeatureEvent,
    profiles: data.agentProfiles,
    providerHealth: data.providerHealth,
    ready: apiState !== "loading",
    selectedChatId,
    sessions: current.sessions,
    slashSkills,
    workspace: data.workspace,
    workspaceId: data.workspace.id,
    workspaces: data.workspaces,
    pendingCounts: pending.list?.bySession,
    threadHeaderAction,
  });
}
