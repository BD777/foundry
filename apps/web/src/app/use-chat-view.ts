import { useMemo, type ReactElement } from "react";
import { useChatFeature, type ChatFeatureEvent } from "../features/chat";
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
  setNotice: (message: string) => void;
  workspaceData: WorkspaceData;
}

/**
 * The Chats page. The chat feature lives for the whole app (its sessions
 * keep streaming while another page shows); the shell keeps the selected
 * chat and applies what the feature answered to the shared data.
 */
export function useChatView({
  current,
  draftFromSource,
  location: { activeView, selectedChatId, setSelectedChatId },
  setNotice,
  workspaceData: { apiState, applyAnswered, data, setData },
}: UseChatViewInput): ReactElement {
  async function handleChatFeatureEvent(
    event: ChatFeatureEvent,
  ): Promise<void> {
    if (event.type === "chat.selected") {
      setSelectedChatId(event.chatId);
      return;
    }
    if (event.type === "notice.requested") {
      setNotice(event.message);
      return;
    }
    if (event.type === "issue.draft.requested") {
      draftFromSource(event.source);
      return;
    }
    if (event.type === "session.answered") {
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

  return useChatFeature({
    active: activeView === "chats",
    agents: current.agents,
    archivedChats: data.chats,
    device: current.device,
    deviceOnline: current.deviceOnline,
    devices: data.devices,
    onEvent: handleChatFeatureEvent,
    profiles: data.agentProfiles,
    ready: apiState !== "loading",
    selectedChatId,
    sessions: current.sessions,
    slashSkills,
    workspace: data.workspace,
    workspaceId: data.workspace.id,
    workspaces: data.workspaces,
  });
}
