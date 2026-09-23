import { FolderPlus, Plus, Search } from "lucide-react";
import { memo, useId, useMemo, useState } from "react";
import { Button } from "../../components/ui/button";
import { TextInput } from "../../components/ui/field";
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
  readOnly = false,
}: {
  workspaceId: string;
  chats: ChatListItem[];
  onNewChat: () => void;
  onChatsDeleted?: (chatIds: string[]) => Promise<void>;
  /** Viewers browse chats but cannot start, rename, move or group them. */
  readOnly?: boolean;
}) {
  const listId = useId();
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
        <strong>Chats</strong>
        <Button
          aria-label="新建分组"
          title="新建分组"
          disabled={!editable}
          onClick={() => createGroup()}
          size="icon"
          variant="icon"
        >
          <FolderPlus size={15} />
        </Button>
        <Button
          aria-label="New chat"
          disabled={readOnly}
          onClick={onNewChat}
          size="icon"
          variant="icon"
        >
          <Plus size={15} />
        </Button>
      </div>
      {layout.error ? (
        <div className="fdy-chat-layout-notice" role="alert">
          <span>{layout.error}</span>
          <Button
            variant="ghost"
            size="sm"
            disabled={layout.saving}
            onClick={layout.retry}
          >
            重新加载
          </Button>
        </div>
      ) : !layout.ready || layout.saving ? (
        <p className="fdy-chat-layout-notice" role="status">
          {layout.saving ? "正在保存分组和顺序…" : "正在加载分组…"}
        </p>
      ) : null}
      <div className="fdy-chat-group-search">
        <Search size={14} aria-hidden="true" />
        <TextInput
          aria-label="搜索会话或分组"
          placeholder="搜索会话或分组"
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
            sessionCount={
              layout.layout.positions.filter(
                (position) => position.groupId === group.id,
              ).length
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
              <p className="fdy-chat-group-empty">暂无会话</p>
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
            未分组
          </div>
        ) : null}
        {filtered.ungrouped.map(renderChat)}
        {query.trim() &&
        !filtered.groups.length &&
        !filtered.ungrouped.length ? (
          <p className="fdy-chat-group-empty" role="status">
            未找到会话或分组
          </p>
        ) : null}
      </ScrollArea>
      <div
        {...resizeHandlers}
        aria-controls={listId}
        aria-label="Resize chats list"
        aria-orientation="vertical"
        aria-valuemin={CHAT_LIST_MIN_WIDTH}
        aria-valuemax={CHAT_LIST_MAX_WIDTH}
        aria-valuenow={CHAT_LIST_DEFAULT_WIDTH}
        className="fdy-chat-list-resizer"
        ref={resizerRef}
        role="separator"
        tabIndex={0}
        title="Drag to resize. Double-click to reset."
      />
    </aside>
  );
});
