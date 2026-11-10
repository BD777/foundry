import { ChevronLeft, MessagesSquare, PanelRight, Target } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import {
  ChatThreadTitle,
  ConversationHeader,
} from "../../components/conversation/conversation-frame";
import type { ChatGoalItem } from "./chat-types";
import { GoalStatusBadge } from "./context/chat-context-goal";
import {
  WaitingChildrenStatus,
  type WaitingChildSession,
} from "./waiting-children-status";

/**
 * The open chat's title, waiting children, narrow screens' way back to the
 * list, and the context panel toggle (`contextOpen` undefined: no panel).
 */
export function ChatThreadHeader({
  contextOpen,
  goal,
  foldedTurns,
  onBack,
  onlyMine,
  onOnlyMineChange,
  onToggleContext,
  title,
  waitingChildCount,
  waitingChildren,
  workspaceId,
}: {
  contextOpen: boolean | undefined;
  /**
   * The open session's goal: where the details panel is a card over the
   * chat, the header names its status and opens the panel.
   */
  goal?: ChatGoalItem;
  /** Turns the person did not start, folded or hidden now. */
  foldedTurns: number;
  onlyMine: boolean;
  onOnlyMineChange: (onlyMine: boolean) => void;
  onBack: () => void;
  onToggleContext: () => void;
  title: ReactNode;
  waitingChildCount?: number;
  waitingChildren?: readonly WaitingChildSession[];
  workspaceId?: string;
}) {
  const { t } = useTranslation("chat");
  return (
    <ConversationHeader>
      <Button
        className="hidden flex-none pl-1 max-[860px]:inline-flex"
        onClick={onBack}
        size="sm"
        variant="ghost"
      >
        <ChevronLeft size={16} />
        {t("list.title")}
      </Button>
      <ChatThreadTitle title={title} />
      <WaitingChildrenStatus
        children={waitingChildren}
        count={waitingChildCount ?? 0}
        workspaceId={workspaceId}
      />
      <div className="inline-flex flex-none items-center gap-2">
        {goal && contextOpen !== undefined ? (
          <Button
            aria-expanded={contextOpen}
            className="hidden max-[1360px]:inline-flex"
            onClick={onToggleContext}
            size="sm"
            variant="ghost"
          >
            <Target aria-hidden="true" size={14} />
            <span className="max-[600px]:sr-only">{t("goal.title")}</span>
            <GoalStatusBadge goal={goal} />
          </Button>
        ) : null}
        {foldedTurns > 0 || onlyMine ? (
          <Button
            aria-pressed={onlyMine}
            className="data-[active=true]:bg-control-ghost-hover data-[active=true]:text-ink"
            data-active={onlyMine ? "true" : "false"}
            onClick={() => onOnlyMineChange(!onlyMine)}
            size="sm"
            title={t(onlyMine ? "onlyMine.offHint" : "onlyMine.onHint")}
            variant="ghost"
          >
            <MessagesSquare aria-hidden="true" size={14} />
            <span className="max-[600px]:sr-only">
              {onlyMine && foldedTurns > 0
                ? t("onlyMine.hidden", { count: foldedTurns })
                : t("onlyMine.label")}
            </span>
          </Button>
        ) : null}
        {contextOpen !== undefined ? (
          <Button
            aria-label={
              contextOpen ? t("contextCard.hide") : t("contextCard.show")
            }
            className="hidden max-[1360px]:inline-flex data-[active=true]:bg-control-ghost-hover data-[active=true]:text-ink"
            data-active={contextOpen ? "true" : "false"}
            onClick={onToggleContext}
            size="icon"
            variant="ghost"
          >
            <PanelRight size={16} />
          </Button>
        ) : null}
      </div>
    </ConversationHeader>
  );
}
