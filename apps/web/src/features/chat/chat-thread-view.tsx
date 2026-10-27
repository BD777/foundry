import { Alert } from "../../components/ui/alert";
import { FieldHint } from "../../components/ui/field";
import { Archive, ChevronRight, FolderPlus, Plus, Search } from "lucide-react";
import { memo, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { TextInput } from "../../components/ui/field";
import { ChatArchiveDialog } from "./chat-archive-dialog";
import { navigateToArchivedChats } from "../../lib/in-app-navigation";
import { ChatListRow } from "./chat-list-row";
import { ChatGroupSection } from "./chat-group-section";
import { filterChatGroups } from "./chat-group-state";
import {
  addChatGroup,
  layoutGroupState,
  moveChat,
  orderedChats,
  type ChatDropTarget,
} from "./chat-layout";
import { useChatLayout } from "./use-chat-layout";
import { useChatListDrag } from "./use-chat-list-drag";
import "./chat-groups.css";
import { ScrollArea } from "../../components/ui/scroll-area";
import type { ChatListItem } from "./chat-surface-types";
import { useChatListResize } from "./use-chat-list-resize";
import {
  CHAT_LIST_DEFAULT_WIDTH,
  CHAT_LIST_MIN_WIDTH,
  CHAT_LIST_MAX_WIDTH,
} from "./chat-list-width";
export const ChatSidebar = memo(function ChatSidebar({
  workspaceId,
  chats,
  onNewChat,
  onChatsDeleted,
  onArchive,
  archiveCount = 0,
  readOnly = false,
}: {
  workspaceId: string;
  archiveCount?: number;
  onArchive?: (input: {
    chatIds?: string[];
    groupId?: string;
    expectedChatIds?: string[];
    selectionAfterArchive?: string;
  }) => Promise<void>;
  chats: ChatListItem[];
  onNewChat: () => void;
  onChatsDeleted?: (chatIds: string[]) => Promise<void>;
  /** Viewers browse chats but cannot start, rename, move or group them. */
  readOnly?: boolean;
}) {
  const { t } = useTranslation("chat");
  const listId = useId();
  const archiveOpener = useRef<HTMLElement | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [archiveInput, setArchiveInput] = useState<{
    chatIds?: string[];
    groupId?: string;
    expectedChatIds?: string[];
    selectionAfterArchive?: string;
  }>();
  // The workspace key on ChatSidebar remounts all local state on workspace changes.
  const layout = useChatLayout(workspaceId, readOnly);
  const editable = layout.ready && !readOnly;
  const [deletedIds, setDeletedIds] = useState<Set<string>>(() => new Set());
  const groupState = useMemo(
    () => layoutGroupState(layout.layout, layout.collapsed),
    [layout.layout, layout.collapsed],
  );
  const sorted = useMemo(
    () =>
      orderedChats(
        chats.filter((chat) => !deletedIds.has(chat.id)),
        layout.layout,
      ),
    [chats, layout.layout, deletedIds],
  );
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string>();
  const editingGroupId = groupState.groups.some(
    (group) => group.id === editingId,
  )
    ? editingId
    : undefined;
  const filtered = useMemo(
    () => filterChatGroups(sorted, groupState, query),
    [sorted, groupState, query],
  );
  const move = (chatId: string, target: ChatDropTarget) => {
    const ids = sorted.map((chat) => chat.id);
    layout.change((current) => moveChat(current, chatId, target, ids));
    if (target.groupId) layout.expand(target.groupId);
  };
  const drag = useChatListDrag(editable && !editingGroupId, move);
  const createGroup = (chatId?: string) => {
    if (!editable) return;
    const id = crypto.randomUUID();
    const ids = sorted.map((chat) => chat.id);
    layout.change((current) => addChatGroup(current, id, chatId, ids));
    layout.expand(id);
    setQuery("");
    setEditingId(id);
  };
  const renderChat = (chat: ChatListItem) => {
    const groupId = groupState.membership[chat.id] ?? "";
    const siblings = sorted.filter(
      (item) => (groupState.membership[item.id] ?? "") === groupId,
    );
    const index = siblings.findIndex((item) => item.id === chat.id);
    const above = siblings[index - 1];
    const below = siblings[index + 1];
    const moveUp = above
      ? () => move(chat.id, { groupId, chatId: above.id, edge: "before" })
      : undefined;
    const moveDown = below
      ? () => move(chat.id, { groupId, chatId: below.id, edge: "after" })
      : undefined;
    return (
      <div
        key={chat.id}
        className="fdy-chat-drag-row"
        data-chat-drop="true"
        data-chat-id={chat.id}
        data-group-id={groupId}
        data-drop-edge={drag.indicator(groupId, chat.id)}
        data-dragging={drag.draggingId === chat.id ? "true" : undefined}
        draggable={editable && !editingGroupId}
        onDragStart={(event) => drag.start(event, chat.id)}
        onDragEnd={drag.end}
        onKeyDown={(event) => {
          if (
            !editable ||
            !event.altKey ||
            !["ArrowUp", "ArrowDown"].includes(event.key)
          )
            return;
          event.preventDefault();
          if (event.key === "ArrowUp") moveUp?.();
          else moveDown?.();
        }}
      >
        <ChatListRow
          chat={chat}
          onArchive={
            onArchive
              ? (opener) => {
                  archiveOpener.current = opener;
                  setArchiveInput({ chatIds: [chat.id] });
                }
              : undefined
          }
          readOnly={readOnly}
          groupMenu={{
            groups: groupState.groups,
            disabled: !editable,
            currentGroupId: groupState.membership[chat.id],
            onMove: (groupId) =>
              move(chat.id, { groupId: groupId ?? "", edge: "before" }),
            onMoveUp: moveUp,
            onMoveDown: moveDown,
            onNewGroup: () => createGroup(chat.id),
          }}
        />
      </div>
    );
  };
  const { sidebarRef, resizerRef, resizeHandlers } = useChatListResize();
  return (
    <aside className="fdy-chat-list" id={listId} ref={sidebarRef}>
      <div className="fdy-side-list-title">
        <strong>{t("list.title")}</strong>
        <Button
          aria-label={t("groups.new")}
          title={t("groups.new")}
          disabled={!editable}
          onClick={() => createGroup()}
          size="icon"
          variant="icon"
        >
          <FolderPlus size={15} />
        </Button>
        <Button
          aria-label={t("list.newChat")}
          disabled={readOnly}
          onClick={onNewChat}
          size="icon"
          variant="icon"
        >
          <Plus size={15} />
        </Button>
      </div>
      {layout.error ? (
        <Alert size="compact" tone="error" title={layout.error}>
          <Button
            variant="ghost"
            size="sm"
            disabled={layout.saving}
            onClick={layout.retry}
          >
            {t("list.reloadGroups")}
          </Button>
        </Alert>
      ) : !layout.ready || layout.saving ? (
        <FieldHint role="status">
          {layout.saving ? t("list.savingLayout") : t("list.loadingLayout")}
        </FieldHint>
      ) : null}
      <div className="fdy-chat-group-search">
        <Search size={14} aria-hidden="true" />
        <TextInput
          ref={searchRef}
          aria-label={t("list.search")}
          placeholder={t("list.search")}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </div>
      <ScrollArea
        className="fdy-chat-list-scroll"
        viewportRef={drag.viewportRef}
        {...drag.handlers}
      >
        {filtered.groups.map((group) => (
          <ChatGroupSection
            key={group.id}
            group={group}
            editing={editingId === group.id}
            disabled={!editable}
            archiveCount={
              sorted.filter(
                (chat) => groupState.membership[chat.id] === group.id,
              ).length
            }
            sessionCount={
              layout.layout.positions.filter(
                (position) => position.groupId === group.id,
              ).length
            }
            onArchive={
              onArchive
                ? (opener) => {
                    archiveOpener.current = opener;
                    setArchiveInput({ groupId: group.id });
                  }
                : undefined
            }
            onDelete={async () => {
              const ids = layout.layout.positions
                .filter((position) => position.groupId === group.id)
                .map((position) => position.chatId);
              await layout.deleteGroup(group.id);
              setDeletedIds((current) => new Set([...current, ...ids]));
              await onChatsDeleted?.(ids);
            }}
            dropEdge={drag.indicator(group.id)}
            onEdit={() => setEditingId(group.id)}
            onRename={(name) => {
              layout.change((current) => ({
                ...current,
                groups: current.groups.map((item) =>
                  item.id === group.id ? { ...item, name } : item,
                ),
              }));
              setEditingId(undefined);
            }}
            onToggle={() => layout.toggle(group.id)}
          >
            {group.chats.length ? (
              group.chats.map(renderChat)
            ) : (
              <p className="fdy-chat-group-empty">{t("list.groupEmpty")}</p>
            )}
          </ChatGroupSection>
        ))}
        {groupState.groups.length > 0 ? (
          <div
            className="fdy-chat-ungrouped-target"
            data-chat-drop="true"
            data-group-id=""
            data-drop-edge={drag.indicator("")}
          >
            {t("list.ungrouped")}
          </div>
        ) : null}
        {filtered.ungrouped.map(renderChat)}
        {query.trim() &&
        !filtered.groups.length &&
        !filtered.ungrouped.length ? (
          <p className="fdy-chat-group-empty" role="status">
            {t("list.noMatches")}
          </p>
        ) : null}
      </ScrollArea>
      <Button
        variant="ghost"
        className="fdy-chat-archive-entry"
        onClick={navigateToArchivedChats}
      >
        <Archive size={14} />
        {t("archive.entry", { count: archiveCount })}
        <ChevronRight size={14} />
      </Button>
      {archiveInput && onArchive ? (
        <ChatArchiveDialog
          returnFocusTo={
            archiveOpener.current?.isConnected
              ? archiveOpener.current
              : searchRef.current
          }
          input={{ ...archiveInput, workspaceId }}
          titles={Object.fromEntries(
            chats.map((chat) => [chat.id, chat.title]),
          )}
          onClose={() => setArchiveInput(undefined)}
          onArchive={(expectedChatIds) => {
            const index = sorted.findIndex((chat) => chat.selected);
            const next = [
              ...sorted.slice(index + 1),
              ...sorted.slice(0, index).reverse(),
            ].find((chat) => !expectedChatIds.includes(chat.id));
            return onArchive({
              ...archiveInput,
              selectionAfterArchive: next?.id ?? "",
              ...(archiveInput.groupId ? { expectedChatIds } : {}),
            });
          }}
        />
      ) : null}
      <div
        {...resizeHandlers}
        aria-controls={listId}
        aria-label={t("list.resize")}
        aria-orientation="vertical"
        aria-valuemin={CHAT_LIST_MIN_WIDTH}
        aria-valuemax={CHAT_LIST_MAX_WIDTH}
        aria-valuenow={CHAT_LIST_DEFAULT_WIDTH}
        className="fdy-chat-list-resizer"
        ref={resizerRef}
        role="separator"
        tabIndex={0}
        title={t("list.resizeHint")}
      />
    </aside>
  );
});
