import { Bot, Check, CircleX, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { subagentUsageSummary } from "../../components/conversation/turn-usage";
import {
  FinishedFold,
  finishedFoldLabel,
  useRevealedRow,
} from "./chat-context-folds";
import type { ChatContextSelection, ChatSubagentItem } from "./chat-types";

function SubagentStatusIcon({
  status,
}: {
  status: ChatSubagentItem["status"];
}) {
  if (status === "running") {
    return <LoaderCircle aria-hidden="true" size={13} />;
  }
  if (status === "completed") {
    return <Check aria-hidden="true" size={13} />;
  }
  return <CircleX aria-hidden="true" size={13} />;
}

/**
 * Running subagents, then every one that ended (completed, failed, canceled)
 * folded, like background tasks; the fold names how many failed.
 */
export function SubagentSection({
  chatKey,
  items,
  onRetry,
  onSelect,
  reveal,
  selectedId,
}: {
  chatKey?: string;
  items: ChatSubagentItem[];
  /** Refreshing the list failed: what is shown is the last list fetched. */
  onRetry?: () => void;
  onSelect?: (item: ChatContextSelection) => void;
  reveal?: { ids: string[] };
  selectedId?: string;
}) {
  const { t } = useTranslation(["chat", "common"]);
  const rowRef = useRevealedRow(reveal);
  // Avatar colors follow the full list, so a row keeps its color when it folds.
  const tones = new Map(items.map((item, index) => [item.id, (index % 3) + 1]));
  const running = items.filter((item) => item.status === "running");
  const finished = items.filter((item) => item.status !== "running");
  const failed = finished.filter((item) => item.status === "failed").length;
  const row = (subagent: ChatSubagentItem) => (
    <Button
      aria-pressed={selectedId === subagent.id}
      className="fdy-chat-context-row fdy-chat-subagent-row"
      data-status={subagent.status}
      data-selected={selectedId === subagent.id ? "true" : "false"}
      key={subagent.id}
      ref={rowRef(subagent.id)}
      onClick={() => onSelect?.(subagent)}
      title={subagent.detail ?? subagent.label}
      variant="ghost"
    >
      <span
        className="fdy-chat-subagent-avatar"
        data-tone={tones.get(subagent.id)}
      >
        <Bot aria-hidden="true" size={15} />
      </span>
      <span className="fdy-chat-context-row-copy">
        <strong>{subagent.label}</strong>
        {subagent.usage ? (
          <em>{subagentUsageSummary(subagent.usage)}</em>
        ) : null}
      </span>
      <span className="fdy-chat-context-status">
        <SubagentStatusIcon status={subagent.status} />
        {t(`contextCard.subagentStatus.${subagent.status}`)}
      </span>
    </Button>
  );
  return (
    <section className="fdy-chat-context-section">
      <h3>{t("contextCard.subagents")}</h3>
      {onRetry ? (
        <p className="fdy-chat-context-refresh-failed" role="status">
          {t("contextCard.subagentsRefreshFailed")}
          <Button onClick={onRetry} size="sm" variant="link">
            {t("common:actions.retry")}
          </Button>
        </p>
      ) : null}
      <div className="fdy-chat-context-list">
        {running.map(row)}
        {finished.length > 0 ? (
          <FinishedFold
            label={finishedFoldLabel(
              t("contextCard.subagentsFinished", { count: finished.length }),
              failed > 0
                ? t("contextCard.foldFailed", { count: failed })
                : undefined,
            )}
            memoryKey={chatKey && `${chatKey}:subagents`}
          >
            {finished.map(row)}
          </FinishedFold>
        ) : null}
      </div>
    </section>
  );
}
