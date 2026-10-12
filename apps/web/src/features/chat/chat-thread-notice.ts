import type {
  AgentSession,
  ChatThread,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { i18n } from "../../i18n";
import { navigateToChat, navigateToIssue } from "../../lib/in-app-navigation";
import type { ChatThreadNotice } from "./chat-surface-types";
import type { ChatSessionThread } from "./chat-types";
import type { LinkedChatSession } from "./use-linked-chat-session";

/**
 * A session Chats does not list (see isChatSession: it works for an Issue,
 * or is one of Foundry's own jobs) reads here; an Issue's continues there.
 */
export function startedElsewhereNotice(
  session: AgentSession | undefined,
): ChatThreadNotice {
  const notice = {
    message: i18n.t("chat:thread.workingForIssue"),
    title: i18n.t("chat:thread.readOnly"),
  };
  if (session?.issueId) {
    const issueId = session.issueId;
    return {
      ...notice,
      action: {
        label: i18n.t("chat:thread.openIssue"),
        onSelect: () => navigateToIssue(issueId),
      },
    };
  }
  return notice;
}

/** Why a chat opened by id is not shown, and where to go instead. */
export function linkedChatNotice(
  linked: LinkedChatSession,
  chatId: string,
  workspaces: readonly WorkspaceProjection[] | undefined,
  showChats: () => void,
): ChatThreadNotice | undefined {
  switch (linked.state) {
    case "none":
    case "found":
      return undefined;
    case "loading":
      return {
        message: i18n.t("chat:thread.opening"),
        title: i18n.t("chat:thread.openingTitle"),
      };
    case "elsewhere": {
      const workspace =
        workspaces?.find((item) => item.id === linked.workspaceId)?.name ||
        i18n.t("chat:thread.otherWorkspace");
      return {
        action: {
          label: i18n.t("chat:thread.openElsewhere", { workspace }),
          onSelect: () => navigateToChat(chatId, linked.workspaceId),
        },
        message: i18n.t("chat:thread.elsewhere", { workspace }),
        title: i18n.t("chat:thread.elsewhereTitle"),
      };
    }
    case "missing":
      return {
        action: {
          label: i18n.t("chat:thread.showChats"),
          onSelect: showChats,
          showsList: true,
        },
        message: i18n.t("chat:thread.missing"),
        title: i18n.t("chat:thread.missingTitle"),
        tone: "warning",
      };
    case "failed":
      return {
        action: { label: i18n.t("chat:thread.retry"), onSelect: linked.retry },
        message: i18n.t("chat:thread.failed"),
        title: i18n.t("chat:thread.failedTitle"),
        tone: "warning",
      };
  }
}

/**
 * The notices of the chat selected: `thread` in place of its composer;
 * `linked` when the chat a link names is not shown (no thread, no chat).
 */
export function selectedChatNotices(input: {
  linked: LinkedChatSession;
  selectedChat?: ChatThread;
  selectedChatId: string;
  selectedThread?: ChatSessionThread;
  showChats: () => void;
  unlistedSelection: boolean;
  workspaces?: readonly WorkspaceProjection[];
}): { linked?: ChatThreadNotice; thread?: ChatThreadNotice } {
  const linked =
    input.selectedThread || input.selectedChat
      ? undefined
      : linkedChatNotice(
          input.linked,
          input.selectedChatId,
          input.workspaces,
          input.showChats,
        );
  return {
    linked,
    thread:
      input.selectedThread && input.unlistedSelection
        ? startedElsewhereNotice(input.selectedThread.sessions[0])
        : linked,
  };
}
