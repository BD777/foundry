import { ChevronDown, ChevronRight, Folder, Pencil } from "lucide-react";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { openContextMenuFromKeyboard } from "../../../components/ui/context-menu-keyboard";
import { Button } from "../../../components/ui/button";
import { cn } from "../../../lib/cn";
import { dropTargetClass } from "./chat-list-styles";
import { TextInput } from "../../../components/ui/field";
import type { ChatGroup } from "./chat-group-state";
import { ChatGroupContextMenu } from "./chat-group-context-menu";

export function ChatGroupSection({
  group,
  editing,
  onEdit,
  onRename,
  onToggle,
  children,
  disabled,
  dropEdge,
  sessionCount,
  archiveCount = sessionCount,
  onDelete,
  onArchive,
}: {
  group: ChatGroup;
  editing: boolean;
  onEdit: () => void;
  onRename: (name: string) => void;
  onToggle: () => void;
  children: ReactNode;
  disabled?: boolean;
  dropEdge?: string;
  sessionCount: number;
  archiveCount?: number;
  onDelete: () => Promise<void>;
  onArchive?: (returnFocusTo: HTMLElement | null) => void;
}) {
  const { t } = useTranslation("chat");
  const contentId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(group.name);
  useLayoutEffect(() => {
    if (!editing) return;
    setDraft(group.name);
    inputRef.current?.focus();
    inputRef.current?.select();
    inputRef.current?.scrollIntoView({ block: "nearest" });
  }, [editing, group.name]);
  return (
    <section className="fdy-chat-group mb-1.5" aria-label={group.name}>
      <ChatGroupContextMenu
        name={group.name}
        sessionCount={sessionCount}
        archiveCount={archiveCount}
        disabled={disabled || editing}
        onRename={onEdit}
        onDelete={onDelete}
        onArchive={onArchive ? () => onArchive(toggleRef.current) : undefined}
      >
        <div
          className={cn(
            "fdy-chat-group-header group/group flex min-w-0 items-center",
            dropTargetClass,
          )}
          onKeyDown={openContextMenuFromKeyboard}
          data-chat-drop="true"
          data-group-id={group.id}
          data-drop-edge={dropEdge}
        >
          <Button
            aria-label={
              group.collapsed
                ? t("groups.expand", { name: group.name })
                : t("groups.collapse", { name: group.name })
            }
            aria-expanded={!group.collapsed}
            aria-controls={contentId}
            ref={toggleRef}
            className={cn(
              "min-w-0 flex-1 justify-start gap-1.5 rounded-md px-1 py-[7px] text-xs text-ink-muted active:scale-100",
              editing && "flex-none",
            )}
            variant="ghost"
            onClick={onToggle}
          >
            {group.collapsed ? (
              <ChevronRight size={14} />
            ) : (
              <ChevronDown size={14} />
            )}
            <Folder size={14} />
            {!editing ? (
              <span className="truncate" title={group.name}>
                {group.name}
              </span>
            ) : null}
          </Button>
          {editing ? (
            <TextInput
              aria-label={t("groups.nameLabel")}
              className="min-w-0 w-full rounded-xs border border-info-text p-[5px] text-xs"
              maxLength={120}
              ref={inputRef}
              value={draft}
              disabled={disabled}
              onChange={(event) => setDraft(event.currentTarget.value)}
              onBlur={() => onRename(draft.trim() || group.name)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter") {
                  event.preventDefault();
                  onRename(draft.trim() || group.name);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  onRename(group.name);
                }
              }}
            />
          ) : (
            <Button
              aria-label={t("groups.renameGroup", { name: group.name })}
              className="size-6 flex-none enabled:opacity-0 enabled:group-focus-within/group:opacity-100 enabled:group-hover/group:opacity-100 enabled:pointer-coarse:opacity-100"
              size="icon"
              variant="ghost"
              onClick={onEdit}
              disabled={disabled}
            >
              <Pencil size={12} />
            </Button>
          )}
        </div>
      </ChatGroupContextMenu>
      <div
        id={contentId}
        className="ml-3 border-l border-line pl-[3px]"
        hidden={group.collapsed}
        data-chat-drop="true"
        data-group-id={group.id}
      >
        {children}
      </div>
    </section>
  );
}
