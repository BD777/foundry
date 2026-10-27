import * as ContextMenu from "@radix-ui/react-context-menu";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  ContextMenuSurface,
  ContextMenuEntry,
  ContextMenuSeparator,
  ContextSubTrigger,
  ContextSubSurface,
} from "../../components/ui/row-menu";
import { useCopied } from "../../lib/use-copied";
import type { ChatListItem } from "./chat-surface-types";
import { ChatGroupMenu, type ChatGroupMenuProps } from "./chat-group-menu";

/** A chat row's context menu: rename, unread, group and order, copy ids. */
export function ChatListRowMenu({
  chat,
  groupMenu,
  onRename,
  readOnly,
  onArchive,
}: {
  chat: ChatListItem;
  groupMenu: ChatGroupMenuProps;
  onRename: () => void;
  readOnly: boolean;
  onArchive?: () => void;
}) {
  const { t } = useTranslation(["chat", "common"]);
  // A dialog opened from the menu keeps its focus when the menu closes.
  const dialogOpening = useRef(false);
  return (
    <ContextMenu.Portal>
      <ContextMenuSurface
        collisionPadding={10}
        onCloseAutoFocus={(event) => {
          if (dialogOpening.current) {
            event.preventDefault();
            dialogOpening.current = false;
          }
        }}
      >
        <ContextMenuEntry
          disabled={readOnly}
          onSelect={() => {
            dialogOpening.current = true;
            onRename();
          }}
        >
          {t("listRow.rename")}
        </ContextMenuEntry>
        <ContextMenuEntry
          disabled={readOnly || chat.renaming}
          onSelect={() => void chat.onAutoRename()}
        >
          {chat.renaming ? t("listRow.autoRenaming") : t("listRow.autoRename")}
        </ContextMenuEntry>
        <ContextMenuEntry onSelect={chat.onMarkUnread}>
          {t("listRow.markUnread")}
        </ContextMenuEntry>
        <ContextMenuSeparator />
        <ChatGroupMenu
          {...groupMenu}
          onNewGroup={() => {
            dialogOpening.current = true;
            groupMenu.onNewGroup();
          }}
        />
        <ContextMenuEntry
          disabled={groupMenu.disabled || !groupMenu.onMoveUp}
          onSelect={groupMenu.onMoveUp}
        >
          {t("listRow.moveUp")}
        </ContextMenuEntry>
        <ContextMenuEntry
          disabled={groupMenu.disabled || !groupMenu.onMoveDown}
          onSelect={groupMenu.onMoveDown}
        >
          {t("listRow.moveDown")}
        </ContextMenuEntry>
        {!chat.issueOwned && onArchive ? (
          <ContextMenuEntry
            disabled={readOnly || chat.archiveBlocked}
            reason={
              chat.archiveBlocked
                ? t("archive.stopFirst")
                : readOnly
                  ? t("thread.readOnly")
                  : undefined
            }
            onSelect={() => {
              dialogOpening.current = true;
              onArchive();
            }}
          >
            {t("archive.action")}
          </ContextMenuEntry>
        ) : null}
        <CopyIdsMenu chat={chat} />
      </ContextMenuSurface>
    </ContextMenu.Portal>
  );
}

/** Copies the chat's Foundry session id, or its runtime's own. */
function CopyIdsMenu({ chat }: { chat: ChatListItem }) {
  const { t } = useTranslation(["chat", "common"]);
  const { copy: copyText } = useCopied(undefined, false);
  const copy = async (value: string) => {
    const copied = await copyText(value);
    chat.onNotify(
      copied ? t("common:actions.copied") : t("listRow.copyFailed"),
      copied ? "success" : "error",
    );
  };
  const rawLabel =
    chat.runtime === "codex"
      ? t("listRow.codexSessionId")
      : chat.runtime === "claude"
        ? t("listRow.claudeSessionId")
        : t("listRow.rawSessionId");
  return (
    <ContextMenu.Sub>
      <ContextSubTrigger>{t("common:actions.copy")}</ContextSubTrigger>
      <ContextMenu.Portal>
        <ContextSubSurface collisionPadding={10} sideOffset={4}>
          <ContextMenuEntry onSelect={() => void copy(chat.foundrySessionId)}>
            {t("listRow.foundrySessionId")}
          </ContextMenuEntry>
          <ContextMenuEntry
            disabled={!chat.nativeSessionId}
            onSelect={() => {
              if (chat.nativeSessionId) void copy(chat.nativeSessionId);
            }}
          >
            {rawLabel}
          </ContextMenuEntry>
        </ContextSubSurface>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  );
}
