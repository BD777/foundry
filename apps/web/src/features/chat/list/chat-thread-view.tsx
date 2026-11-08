import { Alert } from "../../../components/ui/alert";
import {
  Archive,
  ChevronRight,
  FolderPlus,
  Inbox,
  Plus,
  Search,
} from "lucide-react";
import { memo, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../components/ui/button";
import { FieldHint, TextInput } from "../../../components/ui/field";
import { ChatArchiveDialog } from "../archive/chat-archive-dialog";
import { navigateToArchivedChats } from "../../../lib/in-app-navigation";
import { ChatListRow } from "./chat-list-row";
import { ChatGroupSection } from "./chat-group-section";
import { filterChatGroups } from "./chat-group-state";
import { chatsNeedingMe } from "./chat-needs-me";
import {
  addChatGroup,
  layoutGroupState,
  moveChat,
  orderedChats,
  type ChatDropTarget,
} from "./chat-layout";
import { useChatLayout } from "./use-chat-layout";
import { useChatListDrag } from "./use-chat-list-drag";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { Tooltip } from "../../../components/ui/tooltip";
import type { ChatListItem } from "../chat-surface-types";
import { useChatListResize } from "./use-chat-list-resize";
import {
  CHAT_LIST_DEFAULT_WIDTH,
  CHAT_LIST_MIN_WIDTH,
  CHAT_LIST_MAX_WIDTH,
} from "./chat-list-width";
import { Skeleton, Spinner } from "../../../components/ui/loading";
import { cn } from "../../../lib/cn";
import { dropLineClass, dropTargetClass } from "./chat-list-styles";

const sideListAction =
  "size-[26px] rounded-sm bg-control-ghost-hover text-ink-muted hover:bg-control-hover";

export const ChatSidebar = memo(function ChatSidebar({
  workspaceId,
  chats,
  onNewChat,
  onChatsDeleted,
  onArchive,
  archiveCount = 0,
  readOnly = false,
  newChatDisabledReason,
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
  /** Why no chat can be started now, said under the list's header. */
  newChatDisabledReason?: string;
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
  const layout = useChatLayout(workspaceId);
  const editable = layout.ready && !readOnly;
  const newChatReasonId = `${listId}-new-chat-reason`;
  // Groups not read yet: the list's order is not known, so it waits.
  // Without a workspace nothing is read, and nothing waits.
  const reading = Boolean(workspaceId) && !layout.error;
  const firstLoad = reading && !layout.loaded;
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
  // "Needs me": a flat list of the chats that wait for the person.
  const [needsMe, setNeedsMe] = useState(false);
  const needing = useMemo(() => chatsNeedingMe(sorted), [sorted]);
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
        className={cn(
          "relative data-[dragging=true]:opacity-40 [&[draggable=true]]:cursor-grab",
          dropLineClass,
        )}
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
    <aside
      className="relative flex min-h-0 w-[var(--fdy-chat-list-width,270px)] flex-none flex-col border-r border-line-strong bg-list-panel max-[860px]:min-h-0 max-[860px]:w-full max-[860px]:flex-1 max-[860px]:border-r-0 max-[860px]:group-data-[narrow-pane=thread]/chat:hidden"
      id={listId}
      ref={sidebarRef}
    >
      <div className="flex flex-none items-center gap-2 px-4 pt-4 pb-3">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <strong className="text-sm leading-none font-bold text-ink">
            {t("list.title")}
          </strong>
          {/* Groups read again or saved while the list shows: a spinner
              by the title. Their first read fills the list with skeleton
              rows instead. */}
          {reading && layout.loaded && (!layout.ready || layout.saving) ? (
            <Spinner
              label={
                layout.saving ? t("list.savingLayout") : t("list.loadingLayout")
              }
              size={13}
            />
          ) : null}
        </div>
        <Button
          aria-label={t("groups.new")}
          className={sideListAction}
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
          aria-describedby={newChatDisabledReason ? newChatReasonId : undefined}
          className={sideListAction}
          disabled={readOnly || !!newChatDisabledReason}
          onClick={onNewChat}
          size="icon"
          variant="icon"
        >
          <Plus size={15} />
        </Button>
      </div>
      {newChatDisabledReason ? (
        <FieldHint id={newChatReasonId} className="mt-0 px-4 pb-2">
          {newChatDisabledReason}
        </FieldHint>
      ) : null}
      {layout.error ? (
        <Alert
          actions={
            <Button
              variant="secondary"
              size="sm"
              disabled={layout.saving}
              onClick={layout.retry}
            >
              {t("list.reloadGroups")}
            </Button>
          }
          className="mx-3.5 mb-2.5 w-auto"
          size="compact"
          tone="error"
          title={layout.error}
        />
      ) : null}
      <div className="mx-3.5 mb-2.5 flex items-center gap-1.5 rounded-sm border border-line px-2 text-ink-muted">
        <Search size={14} aria-hidden="true" />
        <TextInput
          className="min-w-0 w-full px-0 py-[7px] text-xs"
          ref={searchRef}
          aria-label={t("list.search")}
          placeholder={t("list.search")}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </div>
      {needing.length > 0 || needsMe ? (
        <Button
          aria-pressed={needsMe}
          className="mx-3.5 mb-2 w-fit text-xs data-[active=true]:bg-control-ghost-hover data-[active=true]:text-ink"
          data-active={needsMe ? "true" : "false"}
          onClick={() => setNeedsMe((current) => !current)}
          size="sm"
          title={t(needsMe ? "list.needsMeOff" : "list.needsMeOn")}
          variant="ghost"
        >
          <Inbox aria-hidden="true" size={14} />
          {t("list.needsMe", { count: needing.length })}
        </Button>
      ) : null}
      <ScrollArea
        aria-busy={firstLoad || undefined}
        className="min-h-0 flex-1"
        viewportClassName="px-2.5 pb-3"
        viewportRef={drag.viewportRef}
        {...drag.handlers}
      >
        {firstLoad ? (
          <Skeleton label={t("list.loadingLayout")} rows={6} variant="items" />
        ) : (
          <>
            {needsMe ? (
              needing.length ? (
                needing.map(renderChat)
              ) : (
                <p
                  className="px-2.5 py-1.5 text-xs text-ink-muted"
                  role="status"
                >
                  {t("list.needsMeEmpty")}
                </p>
              )
            ) : null}
            {needsMe
              ? null
              : filtered.groups.map((group) => (
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
                      <p className="px-2.5 py-1.5 text-xs text-ink-muted">
                        {t("list.groupEmpty")}
                      </p>
                    )}
                  </ChatGroupSection>
                ))}
            {!needsMe && groupState.groups.length > 0 ? (
              <div
                className={cn(
                  "px-2.5 py-1.5 text-xs text-ink-muted",
                  dropTargetClass,
                )}
                data-chat-drop="true"
                data-group-id=""
                data-drop-edge={drag.indicator("")}
              >
                {t("list.ungrouped")}
              </div>
            ) : null}
            {needsMe ? null : filtered.ungrouped.map(renderChat)}
            {!needsMe &&
            query.trim() &&
            !filtered.groups.length &&
            !filtered.ungrouped.length ? (
              <p className="px-2.5 py-1.5 text-xs text-ink-muted" role="status">
                {t("list.noMatches")}
              </p>
            ) : null}
          </>
        )}
      </ScrollArea>
      <Button
        variant="ghost"
        className="m-2 flex-wrap items-center rounded-md active:scale-100"
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
      <Tooltip content={t("list.resizeHint")} variant="hint">
        <div
          {...resizeHandlers}
          aria-controls={listId}
          aria-label={t("list.resize")}
          aria-orientation="vertical"
          aria-valuemin={CHAT_LIST_MIN_WIDTH}
          aria-valuemax={CHAT_LIST_MAX_WIDTH}
          aria-valuenow={CHAT_LIST_DEFAULT_WIDTH}
          className="absolute top-0 -right-1 bottom-0 z-9 w-2 cursor-col-resize touch-none outline-none before:absolute before:top-0 before:bottom-0 before:left-[3px] before:w-0.5 before:bg-transparent before:content-[''] hover:before:bg-info-text focus-visible:before:bg-info-text data-[active=true]:before:bg-info-text max-[860px]:hidden"
          ref={resizerRef}
          role="separator"
          tabIndex={0}
        />
      </Tooltip>
    </aside>
  );
});
