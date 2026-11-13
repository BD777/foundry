import { Target } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { controlSessionGoal } from "../../../api";
import { formatTokenCount } from "../../../components/conversation/turn-usage";
import { Badge, type BadgeProps } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { ConfirmButton } from "../../../components/ui/confirm-button";
import { FieldHint } from "../../../components/ui/field";
import { toast } from "../../../components/ui/toast";
import { formatDuration } from "../../../lib/format";
import { i18n } from "../../../i18n";
import type { ChatGoalItem } from "../chat-types";
import {
  ContextHeading,
  ContextRowIcon,
  ContextSection,
} from "../../../components/ui/context-card";

type GoalAction = "pause" | "resume" | "clear";

const statusTone: Record<ChatGoalItem["status"], BadgeProps["tone"]> = {
  active: "online",
  paused: "neutral",
  blocked: "warn",
  usageLimited: "warn",
  budgetLimited: "warn",
  complete: "slate",
};

/** The goal's status as a word with a tinted pill, never colour alone. */
export function GoalStatusBadge({ goal }: { goal: ChatGoalItem }) {
  const { t } = useTranslation("chat");
  return (
    <Badge tone={statusTone[goal.status]}>
      {t(`goal.status.${goal.status}`)}
    </Badge>
  );
}

/**
 * The controls the runtime has for its goal: Codex pauses, resumes and
 * clears it; Claude Code's /goal is only cleared.
 */
export function goalActions(goal: ChatGoalItem): GoalAction[] {
  if (goal.runtime === "claude") return ["clear"];
  if (goal.status === "active") return ["pause", "clear"];
  if (goal.status === "complete") return ["clear"];
  return ["resume", "clear"];
}

/** How far the goal got: Codex's tokens and time, Claude's checks. */
export function goalProgress(goal: ChatGoalItem): string {
  if (goal.runtime === "codex")
    return goal.tokensUsed !== undefined && goal.timeUsedSeconds !== undefined
      ? i18n.t("chat:goal.codexUsage", {
          tokens: formatTokenCount(goal.tokensUsed),
          time: formatDuration(goal.timeUsedSeconds * 1000),
        })
      : "";
  return goal.iterations
    ? i18n.t("chat:goal.claudeChecks", { count: goal.iterations })
    : i18n.t("chat:goal.claudeWaiting");
}

/** The open session's goal: what it is, how far it got, and its controls. */
export function GoalSection({
  canControl,
  goal,
}: {
  canControl: boolean;
  goal: ChatGoalItem;
}) {
  const { t } = useTranslation("chat");
  const [busy, setBusy] = useState<GoalAction>();
  useEffect(() => {
    setBusy(undefined);
  }, [goal.sessionId, goal.status]);
  const run = async (action: GoalAction) => {
    setBusy(action);
    try {
      await controlSessionGoal(goal.sessionId, action);
    } catch (reason) {
      toast({
        tone: "error",
        title: t("goal.controlFailed"),
        description: reason instanceof Error ? reason.message : String(reason),
      });
    } finally {
      setBusy(undefined);
    }
  };
  const progress = goalProgress(goal);
  const actions = canControl ? goalActions(goal) : [];
  return (
    <ContextSection aria-label={t("goal.title")} data-goal-status={goal.status}>
      <ContextHeading>{t("goal.title")}</ContextHeading>
      <div className="grid gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <ContextRowIcon>
            <Target aria-hidden="true" size={16} />
          </ContextRowIcon>
          <div className="grid min-w-0 flex-1 gap-1.5">
            <p className="line-clamp-4 text-sm leading-[1.4] font-semibold wrap-anywhere text-ink">
              {goal.objective}
            </p>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <GoalStatusBadge goal={goal} />
              <span className="text-2xs leading-tight font-medium text-ink-faint">
                {t("goal.label", {
                  runtime: t(`goal.runtime.${goal.runtime}`),
                })}
              </span>
            </div>
            {progress ? (
              <p className="text-2xs leading-tight font-medium text-ink-faint">
                {progress}
              </p>
            ) : null}
            {goal.lastReason ? (
              <p className="line-clamp-3 text-2xs leading-[1.45] wrap-anywhere text-ink-muted">
                {t("goal.lastReason", { reason: goal.lastReason })}
              </p>
            ) : null}
          </div>
        </div>
        {actions.length > 0 ? (
          <div className="grid gap-1.5">
            <div className="flex flex-wrap gap-2">
              {actions.map((action) =>
                action === "clear" ? (
                  <ConfirmButton
                    busy={busy === "clear"}
                    confirmLabel={t("goal.clearConfirm")}
                    disabled={busy !== undefined && busy !== "clear"}
                    key={action}
                    onConfirm={() => void run("clear")}
                    size="sm"
                    variant="secondary"
                  >
                    {busy === "clear" ? t("goal.clearing") : t("goal.clear")}
                  </ConfirmButton>
                ) : (
                  <Button
                    busy={busy === action}
                    disabled={busy !== undefined && busy !== action}
                    key={action}
                    onClick={() => void run(action)}
                    size="sm"
                    variant="secondary"
                  >
                    {busy === action
                      ? t(action === "pause" ? "goal.pausing" : "goal.resuming")
                      : t(action === "pause" ? "goal.pause" : "goal.resume")}
                  </Button>
                ),
              )}
            </div>
            {goal.runtime === "claude" ? (
              <FieldHint className="mt-0">
                {t("goal.claudeClearHint")}
              </FieldHint>
            ) : null}
          </div>
        ) : null}
      </div>
    </ContextSection>
  );
}
