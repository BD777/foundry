import * as ContextMenu from "@radix-ui/react-context-menu";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ChevronRight,
  CircleAlert,
  GitBranch,
  LoaderCircle,
  PauseCircle,
  Terminal,
  X,
} from "lucide-react";
import { memo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActionRow } from "../../components/ui/action-row";
import { Button } from "../../components/ui/button";
import { TextInput } from "../../components/ui/field";
import { IconBox } from "../../components/ui/icon-box";
import { RuntimeMark } from "../../components/ui/runtime-mark";
import type { ChatListItem } from "./chat-surface-types";
import { ChatGroupMenu, type ChatGroupMenuProps } from "./chat-group-menu";

export const ChatListRow = memo(function ChatListRow({
  chat,
  groupMenu,
  readOnly = false,
}: {
  chat: ChatListItem;
  groupMenu: ChatGroupMenuProps;
  readOnly?: boolean;
}) {
  const { t } = useTranslation(["chat", "common"]);
  const [renameOpen, setRenameOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dialogOpening = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rawLabel =
    chat.runtime === "codex"
      ? t("listRow.codexSessionId")
      : chat.runtime === "claude"
        ? t("listRow.claudeSessionId")
        : t("listRow.rawSessionId");
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      chat.onNotify(t("common:actions.copied"));
    } catch {
      chat.onNotify(t("listRow.copyFailed"));
    }
  };
  const save = async () => {
    if (saving || !draft.trim()) return;
    setSaving(true);
    setError("");
    try {
      await chat.onRename(draft.trim());
      setRenameOpen(false);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : t("listRow.renameFailed"),
      );
    } finally {
      setSaving(false);
    }
  };
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
              {chat.spawned ? (
                <GitBranch
                  size={12}
                  className="fdy-chat-row-spawned"
                  aria-label={t("listRow.spawned")}
                  role="img"
                />
              ) : null}
              <strong title={chat.title}>{chat.title}</strong>
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
            {chat.status === "blocked" ? (
              <span
                className="fdy-chat-row-status"
                data-tone="warning"
                role="img"
                aria-label={chat.blockedReason ?? t("listRow.blocked")}
                title={chat.blockedReason ?? t("listRow.blockedTitle")}
              >
                <PauseCircle size={14} />
              </span>
            ) : chat.status === "processing" ? (
              <span
                className="fdy-chat-row-status"
                role="img"
                aria-label={t("listRow.processing")}
                title={t("listRow.processing")}
              >
                <LoaderCircle className="fdy-chat-row-spinner" size={14} />
              </span>
            ) : chat.status === "failed" ? (
              <span
                className="fdy-chat-row-status"
                data-tone="error"
                role="img"
                aria-label={t("listRow.failed")}
                title={t("listRow.failed")}
              >
                <CircleAlert size={14} />
              </span>
            ) : chat.status === "unread" ? (
              <span
                className="fdy-chat-row-unread"
                role="img"
                aria-label={t("listRow.unread")}
                title={t("listRow.unread")}
              />
            ) : null}
          </ActionRow>
        </ContextMenu.Trigger>
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
            <ContextMenu.Item
              asChild
              disabled={readOnly}
              onSelect={() => {
                setDraft(chat.title);
                setError("");
                dialogOpening.current = true;
                setRenameOpen(true);
              }}
            >
              <Button
                className="fdy-chat-list-menu-item"
                variant="ghost"
                disabled={readOnly}
              >
                {t("listRow.rename")}
              </Button>
            </ContextMenu.Item>
            <ContextMenu.Item
              asChild
              disabled={readOnly || chat.renaming}
              onSelect={() => void chat.onAutoRename()}
            >
              <Button
                className="fdy-chat-list-menu-item"
                variant="ghost"
                disabled={readOnly || chat.renaming}
              >
                {chat.renaming
                  ? t("listRow.autoRenaming")
                  : t("listRow.autoRename")}
              </Button>
            </ContextMenu.Item>
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
            <ContextMenu.Item
              asChild
              disabled={groupMenu.disabled || !groupMenu.onMoveUp}
              onSelect={groupMenu.onMoveUp}
            >
              <Button
                className="fdy-chat-list-menu-item"
                variant="ghost"
                disabled={groupMenu.disabled || !groupMenu.onMoveUp}
              >
                {t("listRow.moveUp")}
              </Button>
            </ContextMenu.Item>
            <ContextMenu.Item
              asChild
              disabled={groupMenu.disabled || !groupMenu.onMoveDown}
              onSelect={groupMenu.onMoveDown}
            >
              <Button
                className="fdy-chat-list-menu-item"
                variant="ghost"
                disabled={groupMenu.disabled || !groupMenu.onMoveDown}
              >
                {t("listRow.moveDown")}
              </Button>
            </ContextMenu.Item>
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
                  <ContextMenu.Item
                    asChild
                    disabled={!chat.nativeSessionId}
                    onSelect={() => {
                      if (chat.nativeSessionId) void copy(chat.nativeSessionId);
                    }}
                  >
                    <Button
                      className="fdy-chat-list-menu-item"
                      variant="ghost"
                      disabled={!chat.nativeSessionId}
                    >
                      {rawLabel}
                    </Button>
                  </ContextMenu.Item>
                </ContextMenu.SubContent>
              </ContextMenu.Portal>
            </ContextMenu.Sub>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      <Dialog.Root
        open={renameOpen}
        onOpenChange={(open) => {
          if (!saving) setRenameOpen(open);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fdy-chat-rename-overlay" />
          <Dialog.Content
            className="fdy-chat-rename-dialog"
            aria-describedby={undefined}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              inputRef.current?.focus();
              inputRef.current?.select();
            }}
          >
            <Dialog.Title className="fdy-chat-rename-title">
              {t("listRow.renameTitle")}
            </Dialog.Title>
            <TextInput
              aria-label={t("listRow.nameLabel")}
              className="fdy-chat-rename-input"
              maxLength={120}
              ref={inputRef}
              value={draft}
              disabled={saving}
              onChange={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void save();
                }
              }}
            />
            {error ? (
              <p className="fdy-chat-rename-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="fdy-chat-rename-actions">
              <Dialog.Close asChild>
                <Button variant="ghost" disabled={saving}>
                  {t("common:actions.cancel")}
                </Button>
              </Dialog.Close>
              <Button
                variant="primary"
                disabled={saving || !draft.trim()}
                onClick={() => void save()}
              >
                {saving ? t("common:actions.saving") : t("common:actions.save")}
              </Button>
            </div>
            <Dialog.Close asChild>
              <Button
                aria-label={t("listRow.closeRename")}
                className="fdy-chat-rename-close"
                variant="ghost"
                size="icon"
                disabled={saving}
              >
                <X size={16} />
              </Button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
});
