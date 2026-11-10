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
import { memo, useRef } from "react";
import { cn } from "../../../lib/cn";
import { useTranslation } from "react-i18next";
import { openContextMenuFromKeyboard } from "../../../components/ui/context-menu-keyboard";
import { ActionRow } from "../../../components/ui/action-row";
import { IconBox } from "../../../components/ui/icon-box";
import { RuntimeMark } from "../../../components/agent-runtime/runtime-mark";
import type { ChatListItem } from "../chat-surface-types";
import type { ChatGroupMenuProps } from "./chat-group-menu";
import { ChatListRowMenu } from "./chat-list-row-menu";
import { ChatRenameDialog, useChatRename } from "./chat-rename-dialog";
import { WaitingChildrenStatus } from "../waiting-children-status";

export const ChatListRow = memo(function ChatListRow({
  chat,
  groupMenu,
  onArchive,
  readOnly = false,
}: {
  chat: ChatListItem;
  groupMenu: ChatGroupMenuProps;
  readOnly?: boolean;
  onArchive?: (returnFocusTo: HTMLElement | null) => void;
}) {
  const contextOrigin = useRef<HTMLElement | null>(null);
  const rename = useChatRename(chat.title, chat.onRename);
  return (
    <>
      <ContextMenu.Root>
        <div className="flex min-w-0 items-center">
          <ContextMenu.Trigger asChild>
            <ActionRow
              className="fdy-chat-row relative mb-[3px] min-w-0 flex-1 items-center gap-[9px] overflow-hidden rounded-md px-2.5 py-1.5"
              data-unread={chat.unread ? "true" : "false"}
              density="compact"
              onKeyDown={openContextMenuFromKeyboard}
              onContextMenu={(event) => {
                contextOrigin.current = event.currentTarget;
              }}
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
              <span className="flex min-w-0 flex-1 flex-col gap-px">
                <strong
                  className="block truncate text-xs leading-[1.3] font-semibold text-ink max-[860px]:leading-tight"
                  title={chat.title}
                >
                  {chat.title}
                </strong>
                {chat.startedBy ? (
                  <span className="flex items-center gap-[3px] overflow-hidden text-2xs leading-[1.3] font-medium text-ink-faint">
                    <GitBranch
                      className="flex-none"
                      size={10}
                      aria-hidden="true"
                    />
                    <span className="truncate" title={chat.startedBy}>
                      {chat.startedBy}
                    </span>
                  </span>
                ) : null}
              </span>
              {chat.updateTime && !chat.waitingChildCount ? (
                <time
                  className="flex-none text-2xs font-medium whitespace-nowrap text-ink-faint tabular-nums"
                  dateTime={chat.updateTime.dateTime}
                  title={chat.updateTime.title}
                >
                  {chat.updateTime.label}
                </time>
              ) : null}
              {chat.pendingCount ? (
                <ChatRowPending count={chat.pendingCount} />
              ) : null}
              <ChatRowStatus chat={chat} />
            </ActionRow>
          </ContextMenu.Trigger>
        </div>
        <ChatListRowMenu
          chat={chat}
          onArchive={
            onArchive ? () => onArchive(contextOrigin.current) : undefined
          }
          groupMenu={groupMenu}
          onRename={rename.begin}
          readOnly={readOnly}
        />
      </ContextMenu.Root>
      <ChatRenameDialog rename={rename} />
    </>
  );
});

const statusMark = "inline-flex flex-none items-center text-ink-muted";
const warningMark = cn(statusMark, "text-warning-text");

/**
 * The row's one status mark: blocked, waiting for its offline device,
 * working, failed, unread or scheduled.
 */
function ChatRowStatus({ chat }: { chat: ChatListItem }) {
  const { t } = useTranslation("chat");
  if (chat.waitingChildCount) {
    return <WaitingChildrenStatus compact count={chat.waitingChildCount} />;
  }
  if (chat.status === "waiting") {
    const label = t("listRow.waitingForDevice", { device: chat.waitingFor });
    return (
      <span className={warningMark} role="img" aria-label={label} title={label}>
        <Hourglass size={14} />
      </span>
    );
  }
  if (chat.status === "blocked")
    return (
      <span
        className={warningMark}
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
        className={statusMark}
        role="img"
        aria-label={t("listRow.processing")}
        title={t("listRow.processing")}
      >
        <LoaderCircle
          className="animate-row-spin motion-reduce:animate-none"
          size={14}
        />
      </span>
    );
  if (chat.status === "failed")
    return (
      <span
        className={cn(statusMark, "text-error-text")}
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
        className="size-[7px] flex-none rounded-full bg-info-text"
        role="img"
        aria-label={t("listRow.unread")}
        title={t("listRow.unread")}
      />
    );
  if (chat.scheduled)
    return (
      <span
        className={statusMark}
        role="img"
        aria-label={t("listRow.scheduled")}
        title={t("listRow.scheduled")}
      >
        <Clock size={14} />
      </span>
    );
  return null;
}

/** The chat's open pending items (DEV-079), as a count with its words. */
function ChatRowPending({ count }: { count: number }) {
  const { t } = useTranslation("chat");
  const label = t("listRow.pending", { count });
  return (
    <span
      aria-label={label}
      className="inline-grid h-[18px] min-w-[18px] flex-none place-items-center rounded-md bg-accent-soft px-[5px] text-2xs font-bold text-(--fdy-accent-dark) tabular-nums"
      role="img"
      title={label}
    >
      {count}
    </span>
  );
}
