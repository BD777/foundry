import * as ContextMenu from "@radix-ui/react-context-menu";
import { Check, ChevronRight, FolderPlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import type { ChatGroup } from "./chat-group-state";

export interface ChatGroupMenuProps {
  groups: ChatGroup[];
  currentGroupId?: string;
  onMove: (groupId?: string) => void;
  onNewGroup: () => void;
  disabled?: boolean;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}

export function ChatGroupMenu({
  groups,
  currentGroupId,
  onMove,
  onNewGroup,
  disabled,
}: ChatGroupMenuProps) {
  const { t } = useTranslation("chat");
  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger asChild disabled={disabled}>
        <Button
          className="fdy-chat-list-menu-item"
          variant="ghost"
          disabled={disabled}
        >
          {t("groups.moveTo")}
          <ChevronRight size={14} />
        </Button>
      </ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent
          className="fdy-chat-list-menu fdy-chat-group-menu"
          collisionPadding={10}
          sideOffset={4}
        >
          {groups.map((group) => (
            <ContextMenu.Item
              key={group.id}
              asChild
              onSelect={() => onMove(group.id)}
            >
              <Button className="fdy-chat-list-menu-item" variant="ghost">
                <span className="fdy-chat-group-menu-name" title={group.name}>
                  {group.name}
                </span>
                {group.id === currentGroupId ? (
                  <Check size={14} aria-label={t("groups.current")} />
                ) : null}
              </Button>
            </ContextMenu.Item>
          ))}
          {currentGroupId ? (
            <ContextMenu.Item asChild onSelect={() => onMove()}>
              <Button className="fdy-chat-list-menu-item" variant="ghost">
                {t("groups.removeFrom")}
              </Button>
            </ContextMenu.Item>
          ) : null}
          {groups.length > 0 ? (
            <ContextMenu.Separator className="fdy-chat-list-menu-separator" />
          ) : null}
          <ContextMenu.Item asChild onSelect={onNewGroup}>
            <Button className="fdy-chat-list-menu-item" variant="ghost">
              {t("groups.new")}
              <FolderPlus size={14} />
            </Button>
          </ContextMenu.Item>
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  );
}
