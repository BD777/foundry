import * as ContextMenu from "@radix-ui/react-context-menu";
import { useTranslation } from "react-i18next";
import {
  ContextMenuEntry,
  ContextMenuSeparator,
  ContextSubSurface,
  ContextSubTrigger,
} from "../../components/ui/row-menu";
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
      <ContextSubTrigger disabled={disabled}>
        {t("groups.moveTo")}
      </ContextSubTrigger>
      <ContextMenu.Portal>
        <ContextSubSurface>
          {groups.map((group) => (
            <ContextMenuEntry
              key={group.id}
              selected={group.id === currentGroupId}
              onSelect={() => onMove(group.id)}
            >
              {group.name}
            </ContextMenuEntry>
          ))}
          {currentGroupId ? (
            <ContextMenuEntry onSelect={() => onMove()}>
              {t("groups.removeFrom")}
            </ContextMenuEntry>
          ) : null}
          {groups.length ? <ContextMenuSeparator /> : null}
          <ContextMenuEntry onSelect={onNewGroup}>
            {t("groups.new")}
          </ContextMenuEntry>
        </ContextSubSurface>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  );
}
