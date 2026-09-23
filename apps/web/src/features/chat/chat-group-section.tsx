import { ChevronDown, ChevronRight, Folder, Pencil } from "lucide-react";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "../../components/ui/button";
import { TextInput } from "../../components/ui/field";
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
  onDelete,
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
  onDelete: () => Promise<void>;
}) {
  const contentId = useId();
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
    <section className="fdy-chat-group" aria-label={group.name}>
      <ChatGroupContextMenu
        name={group.name}
        sessionCount={sessionCount}
        disabled={disabled || editing}
        onRename={onEdit}
        onDelete={onDelete}
      >
        <div
          className="fdy-chat-group-header"
          data-chat-drop="true"
          data-group-id={group.id}
          data-drop-edge={dropEdge}
        >
          <Button
            aria-label={`${group.collapsed ? "展开" : "折叠"}分组 ${group.name}`}
            aria-expanded={!group.collapsed}
            aria-controls={contentId}
            className="fdy-chat-group-toggle"
            variant="ghost"
            onClick={onToggle}
          >
            {group.collapsed ? (
              <ChevronRight size={14} />
            ) : (
              <ChevronDown size={14} />
            )}
            <Folder size={14} />
            {!editing ? <span title={group.name}>{group.name}</span> : null}
          </Button>
          {editing ? (
            <TextInput
              aria-label="分组名称"
              className="fdy-chat-group-name"
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
              aria-label={`重命名分组 ${group.name}`}
              className="fdy-chat-group-edit"
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
        className="fdy-chat-group-children"
        hidden={group.collapsed}
        data-chat-drop="true"
        data-group-id={group.id}
      >
        {children}
      </div>
    </section>
  );
}
