import * as ContextMenu from "@radix-ui/react-context-menu";
import { ChevronRight } from "lucide-react";
import { useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { useCopied } from "../../lib/use-copied";
import type { ChatListItem } from "./chat-surface-types";
import { ChatGroupMenu, type ChatGroupMenuProps } from "./chat-group-menu";

/** A chat row's context menu: rename, unread, group and order, copy ids. */
export function ChatListRowMenu({
  chat,
  groupMenu,
  onRename,
  readOnly,
}: {
  chat: ChatListItem;
  groupMenu: ChatGroupMenuProps;
  onRename: () => void;
  readOnly: boolean;
}) {
  const { t } = useTranslation(["chat", "common"]);
  // A dialog opened from the menu keeps its focus when the menu closes.
  const dialogOpening = useRef(false);
  return (
    <ContextMenu.Portal>
      <ContextMenu.Content
        className="fdy-chat-list-menu"
        collisionPadding={10}
        onCloseAutoFocus={(event) => {
          if (dialogOpening.current) {
            event.preventDefault();
            dialogOpening.current = false;
          }
        }}
      >
        <RowMenuItem
          disabled={readOnly}
          onSelect={() => {
            dialogOpening.current = true;
            onRename();
          }}
        >
          {t("listRow.rename")}
        </RowMenuItem>
        <RowMenuItem
          disabled={readOnly || chat.renaming}
          onSelect={() => void chat.onAutoRename()}
        >
          {chat.renaming ? t("listRow.autoRenaming") : t("listRow.autoRename")}
        </RowMenuItem>
        <ContextMenu.Item asChild onSelect={chat.onMarkUnread}>
          <Button className="fdy-chat-list-menu-item" variant="ghost">
            {t("listRow.markUnread")}
          </Button>
        </ContextMenu.Item>
        <ContextMenu.Separator className="fdy-chat-list-menu-separator" />
        <ChatGroupMenu
          {...groupMenu}
          onNewGroup={() => {
            dialogOpening.current = true;
            groupMenu.onNewGroup();
          }}
        />
        <RowMenuItem
          disabled={groupMenu.disabled || !groupMenu.onMoveUp}
          onSelect={groupMenu.onMoveUp}
        >
          {t("listRow.moveUp")}
        </RowMenuItem>
        <RowMenuItem
          disabled={groupMenu.disabled || !groupMenu.onMoveDown}
          onSelect={groupMenu.onMoveDown}
        >
          {t("listRow.moveDown")}
        </RowMenuItem>
        <CopyIdsMenu chat={chat} />
      </ContextMenu.Content>
    </ContextMenu.Portal>
  );
}

function RowMenuItem({
  children,
  disabled,
  onSelect,
}: {
  children: ReactNode;
  disabled?: boolean;
  onSelect?: () => void;
}) {
  return (
    <ContextMenu.Item asChild disabled={disabled} onSelect={onSelect}>
      <Button
        className="fdy-chat-list-menu-item"
        variant="ghost"
        disabled={disabled}
      >
        {children}
      </Button>
    </ContextMenu.Item>
  );
}

/** Copies the chat's Foundry session id, or its runtime's own. */
function CopyIdsMenu({ chat }: { chat: ChatListItem }) {
  const { t } = useTranslation(["chat", "common"]);
  const { copy: copyText } = useCopied();
  const copy = async (value: string) =>
    chat.onNotify(
      (await copyText(value))
        ? t("common:actions.copied")
        : t("listRow.copyFailed"),
    );
  const rawLabel =
    chat.runtime === "codex"
      ? t("listRow.codexSessionId")
      : chat.runtime === "claude"
        ? t("listRow.claudeSessionId")
        : t("listRow.rawSessionId");
  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger asChild>
        <Button className="fdy-chat-list-menu-item" variant="ghost">
          {t("common:actions.copy")}
          <ChevronRight size={14} />
        </Button>
      </ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent
          className="fdy-chat-list-menu"
          collisionPadding={10}
          sideOffset={4}
        >
          <ContextMenu.Item
            asChild
            onSelect={() => void copy(chat.foundrySessionId)}
          >
            <Button className="fdy-chat-list-menu-item" variant="ghost">
              {t("listRow.foundrySessionId")}
            </Button>
          </ContextMenu.Item>
          <RowMenuItem
            disabled={!chat.nativeSessionId}
            onSelect={() => {
              if (chat.nativeSessionId) void copy(chat.nativeSessionId);
            }}
          >
            {rawLabel}
          </RowMenuItem>
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  );
}
