import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  CircleAlert,
  Clock,
  GitBranch,
  Hourglass,
  LoaderCircle,
  PauseCircle,
  Terminal,
} from "lucide-react";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { ActionRow } from "../../components/ui/action-row";
import { IconBox } from "../../components/ui/icon-box";
import { RuntimeMark } from "../../components/ui/runtime-mark";
import type { ChatListItem } from "./chat-surface-types";
import type { ChatGroupMenuProps } from "./chat-group-menu";
import { ChatListRowMenu } from "./chat-list-row-menu";
import { ChatRenameDialog, useChatRename } from "./chat-rename-dialog";

export const ChatListRow = memo(function ChatListRow({
  chat,
  groupMenu,
  readOnly = false,
}: {
  chat: ChatListItem;
  groupMenu: ChatGroupMenuProps;
  readOnly?: boolean;
}) {
  const rename = useChatRename(chat.title, chat.onRename);
  return (
    <>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <ActionRow
            className="fdy-chat-row"
            data-unread={chat.unread ? "true" : "false"}
            density="compact"
            onClick={chat.onSelect}
            selected={chat.selected}
          >
            {chat.runtime ? (
              <RuntimeMark runtime={chat.runtime} size="chat" />
            ) : (
              <IconBox size="chat" tone="brass">
                <Terminal size={14} />
              </IconBox>
            )}
            <span className="fdy-chat-row-copy">
              <strong title={chat.title}>{chat.title}</strong>
              {chat.startedBy ? (
                <span className="fdy-chat-row-origin">
                  <GitBranch size={10} aria-hidden="true" />
                  <span title={chat.startedBy}>{chat.startedBy}</span>
                </span>
              ) : null}
            </span>
            {chat.updateTime ? (
              <time
                className="fdy-chat-row-time"
                dateTime={chat.updateTime.dateTime}
                title={chat.updateTime.title}
              >
                {chat.updateTime.label}
              </time>
            ) : null}
            <ChatRowStatus chat={chat} />
          </ActionRow>
        </ContextMenu.Trigger>
        <ChatListRowMenu
          chat={chat}
          groupMenu={groupMenu}
          onRename={rename.begin}
          readOnly={readOnly}
        />
      </ContextMenu.Root>
      <ChatRenameDialog rename={rename} />
    </>
  );
});

/**
 * The row's one status mark: blocked, waiting for its offline device,
 * working, failed, unread or scheduled.
 */
function ChatRowStatus({ chat }: { chat: ChatListItem }) {
  const { t } = useTranslation("chat");
  if (chat.status === "waiting") {
    const label = t("listRow.waitingForDevice", { device: chat.waitingFor });
    return (
      <span
        className="fdy-chat-row-status"
        data-tone="warning"
        role="img"
        aria-label={label}
        title={label}
      >
        <Hourglass size={14} />
      </span>
    );
  }
  if (chat.status === "blocked")
    return (
      <span
        className="fdy-chat-row-status"
        data-tone="warning"
        role="img"
        aria-label={chat.blockedReason ?? t("listRow.blocked")}
        title={chat.blockedReason ?? t("listRow.blockedTitle")}
      >
        <PauseCircle size={14} />
      </span>
    );
  if (chat.status === "processing")
    return (
      <span
        className="fdy-chat-row-status"
        role="img"
        aria-label={t("listRow.processing")}
        title={t("listRow.processing")}
      >
        <LoaderCircle className="fdy-chat-row-spinner" size={14} />
      </span>
    );
  if (chat.status === "failed")
    return (
      <span
        className="fdy-chat-row-status"
        data-tone="error"
        role="img"
        aria-label={t("listRow.failed")}
        title={t("listRow.failed")}
      >
        <CircleAlert size={14} />
      </span>
    );
  if (chat.status === "unread")
    return (
      <span
        className="fdy-chat-row-unread"
        role="img"
        aria-label={t("listRow.unread")}
        title={t("listRow.unread")}
      />
    );
  if (chat.scheduled)
    return (
      <span
        className="fdy-chat-row-status"
        role="img"
        aria-label={t("listRow.scheduled")}
        title={t("listRow.scheduled")}
      >
        <Clock size={14} />
      </span>
    );
  return null;
}
