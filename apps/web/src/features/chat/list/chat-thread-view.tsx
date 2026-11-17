import { Alert } from "../../../components/ui/alert";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  Hash,
  Inbox,
  MessagesSquare,
  Plus,
  RotateCcw,
  Search,
  UserRound,
} from "lucide-react";
import { memo, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../components/ui/button";
import { ToastFeedback } from "../../../components/ui/toast";
import { startMessageChannelNewSession } from "../../../api";
import { serverErrorText } from "../../../lib/errors";
import { clockTime } from "../../../lib/time-format";
import {
  channelChatGroups,
  type ChannelChatGroup,
} from "./channel-chat-groups";
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
  channelWorkspace = false,
  groupMemberCounts,
  groupMemberLoading,
  groupMemberLoaded,
  groupMemberExhausted,
  onLoadGroupMembers,
}: {
  workspaceId: string;
  archiveCount?: number;
  /** Each folder's listable chats, and the pages it adds on demand. */
  groupMemberCounts?: Readonly<Record<string, number>>;
  groupMemberLoading?: Readonly<Record<string, boolean>>;
  groupMemberLoaded?: Readonly<Record<string, boolean>>;
  groupMemberExhausted?: Readonly<Record<string, boolean>>;
  onLoadGroupMembers?: (groupId: string) => void;
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
  /**
   * A message channel's workspace (DEV-234): its sessions grouped by source
   * conversation, no new chat and no user groups.
   */
  channelWorkspace?: boolean;
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
  const layout = useChatLayout(workspaceId, !channelWorkspace);
  const editable = layout.ready && !readOnly && !channelWorkspace;
  const newChatReasonId = `${listId}-new-chat-reason`;
  // Groups not read yet: the list's order is not known, so it waits.
  // Without a workspace nothing is read, and nothing waits. A channel
  // workspace groups its sessions itself, so it has no layout to wait for.
  const reading = Boolean(workspaceId) && !channelWorkspace && !layout.error;
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
  // A channel workspace: its source conversations, not the person's groups.
  const [collapsedChannels, setCollapsedChannels] = useState<Set<string>>(
    () => new Set(),
  );
  const [renewing, setRenewing] = useState<string>();
  const [renewNote, setRenewNote] = useState("");
  const [renewError, setRenewError] = useState("");
  const channelGroups = useMemo(() => {
    if (!channelWorkspace) return [];
    const search = query.trim().toLocaleLowerCase();
    const matching = search
      ? sorted.filter(
          (chat) =>
            chat.title.toLocaleLowerCase().includes(search) ||
            (chat.channelOrigin?.conversation.name ?? "")
              .toLocaleLowerCase()
              .includes(search),
        )
      : sorted;
    return channelChatGroups(matching);
  }, [channelWorkspace, sorted, query]);
  const toggleChannel = (key: string) =>
    setCollapsedChannels((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  async function startChannelSession(group: ChannelChatGroup): Promise<void> {
    const origin = group.chats[0]?.channelOrigin;
    if (!origin || renewing) return;
    setRenewing(group.key);
    setRenewNote("");
    setRenewError("");
    try {
      await startMessageChannelNewSession(
        origin.assistantId,
        origin.channelId,
        group.sessionKey,
      );
      setRenewNote(t("channelGroups.nextSessionDone"));
    } catch (reason) {
      setRenewError(serverErrorText(reason));
    } finally {
      setRenewing(undefined);
    }
  }
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
        {channelWorkspace ? null : (
          <>
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
              aria-describedby={
                newChatDisabledReason ? newChatReasonId : undefined
              }
              className={sideListAction}
              disabled={readOnly || !!newChatDisabledReason}
              onClick={onNewChat}
              size="icon"
              variant="icon"
            >
              <Plus size={15} />
            </Button>
          </>
        )}
      </div>
      {renewNote || renewError ? (
        <div className="px-3.5 pb-2">
          <ToastFeedback
            title={
              renewError ? t("channelGroups.nextSessionFailed") : renewNote
            }
            tone={renewError ? "error" : "success"}
          >
            {renewError || undefined}
          </ToastFeedback>
        </div>
      ) : null}
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
            {needsMe || channelWorkspace
              ? null
              : filtered.groups.map((group) => {
                  const shown = sorted.filter(
                    (chat) => groupState.membership[chat.id] === group.id,
                  ).length;
                  // The chats the session list's window leaves out: the
                  // folder draws what it holds, not what one page returned.
                  const olderCount =
                    query.trim() || groupMemberExhausted?.[group.id]
                      ? 0
                      : Math.max(
                          0,
                          (groupMemberCounts?.[group.id] ?? 0) - shown,
                        );
                  return (
                    <ChatGroupSection
                      key={group.id}
                      group={group}
                      editing={editingId === group.id}
                      disabled={!editable}
                      olderCount={olderCount}
                      olderLoading={Boolean(groupMemberLoading?.[group.id])}
                      olderExpanded={Boolean(groupMemberLoaded?.[group.id])}
                      onLoadOlder={
                        olderCount && onLoadGroupMembers
                          ? () => onLoadGroupMembers(group.id)
                          : undefined
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
                        setDeletedIds(
                          (current) => new Set([...current, ...ids]),
                        );
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
                      ) : olderCount ? null : (
                        <p className="px-2.5 py-1.5 text-xs text-ink-muted">
                          {t("list.groupEmpty")}
                        </p>
                      )}
                    </ChatGroupSection>
                  );
                })}
            {!needsMe && !channelWorkspace && groupState.groups.length > 0 ? (
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
            {needsMe || channelWorkspace
              ? null
              : filtered.ungrouped.map(renderChat)}
            {!needsMe &&
            !channelWorkspace &&
            query.trim() &&
            !filtered.groups.length &&
            !filtered.ungrouped.length ? (
              <p className="px-2.5 py-1.5 text-xs text-ink-muted" role="status">
                {t("list.noMatches")}
              </p>
            ) : null}
            {needsMe || !channelWorkspace ? null : channelGroups.length ? (
              channelGroups.map((group) => (
                <ChannelConversationSection
                  collapsed={collapsedChannels.has(group.key)}
                  group={group}
                  key={group.key}
                  onNewSession={() => void startChannelSession(group)}
                  onToggle={() => toggleChannel(group.key)}
                  renewDisabled={renewing !== undefined}
                  renewing={renewing === group.key}
                >
                  {group.chats.map(renderChat)}
                </ChannelConversationSection>
              ))
            ) : (
              <p className="px-2.5 py-1.5 text-xs text-ink-muted" role="status">
                {query.trim() ? t("list.noMatches") : t("channelGroups.empty")}
              </p>
            )}
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
          shownChatIds={chats.map((chat) => chat.id)}
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

/**
 * One source conversation of a channel workspace (DEV-234): its name and
 * latest sender/time, its sessions, and the choice that its next message
 * starts a new session.
 */
function ChannelConversationSection({
  group,
  collapsed,
  onToggle,
  onNewSession,
  renewing,
  renewDisabled,
  children,
}: {
  group: ChannelChatGroup;
  collapsed: boolean;
  onToggle: () => void;
  onNewSession: () => void;
  renewing: boolean;
  renewDisabled: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation("chat");
  const contentId = useId();
  const kind = group.conversation.kind;
  const name =
    group.conversation.name ||
    t(`channelGroups.kind.${kind}`, { defaultValue: kind });
  const Icon =
    kind === "channel" ? Hash : kind === "group" ? MessagesSquare : UserRound;
  const meta = [
    group.lastSender,
    group.lastAt ? clockTime(group.lastAt, { date: "short" }) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <section aria-label={name} className="fdy-chat-group mb-1.5">
      <div className="group/channel flex min-w-0 items-center gap-1">
        <Button
          aria-controls={contentId}
          aria-expanded={!collapsed}
          className="min-w-0 flex-1 justify-start gap-1.5 rounded-md px-1 py-[7px] text-xs text-ink-muted active:scale-100"
          onClick={onToggle}
          variant="ghost"
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          <Icon aria-hidden="true" size={14} />
          <span className="grid min-w-0 flex-1 gap-0.5 text-left">
            <span className="flex min-w-0 items-center gap-1">
              <span className="flex-none text-2xs text-ink-faint">
                {group.source}
              </span>
              <span aria-hidden="true" className="flex-none text-ink-faint">
                ·
              </span>
              <span
                className="min-w-0 truncate font-medium text-ink"
                title={name}
              >
                {name}
              </span>
            </span>
            {meta ? (
              <span
                className="min-w-0 truncate text-2xs text-ink-faint"
                title={meta}
              >
                {meta}
              </span>
            ) : null}
          </span>
        </Button>
        <Tooltip content={t("channelGroups.nextSessionHint")} variant="hint">
          <Button
            aria-label={t("channelGroups.nextSession")}
            busy={renewing}
            className="size-6 flex-none"
            disabled={renewDisabled || !group.sessionKey}
            onClick={onNewSession}
            size="icon"
            variant="ghost"
          >
            <RotateCcw aria-hidden="true" size={12} />
          </Button>
        </Tooltip>
      </div>
      <div
        className="ml-3 border-l border-line pl-[3px]"
        hidden={collapsed}
        id={contentId}
      >
        {children}
      </div>
    </section>
  );
}
