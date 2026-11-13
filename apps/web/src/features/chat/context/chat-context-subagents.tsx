import { Bot, Check, CircleX, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import {
  ContextAvatar,
  ContextHeading,
  ContextList,
  ContextRow,
  ContextRowCopy,
  ContextSection,
  ContextStatus,
  statusToneOf,
} from "../../../components/ui/context-card";
import { subagentUsageSummary } from "../../../components/conversation/turn-usage";
import {
  FinishedFold,
  finishedFoldLabel,
  useRevealedRow,
} from "./chat-context-folds";
import type { ChatContextSelection, ChatSubagentItem } from "../chat-types";

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
    <ContextRow
      aria-pressed={selectedId === subagent.id}
      data-status={subagent.status}
      key={subagent.id}
      ref={rowRef(subagent.id)}
      onClick={() => onSelect?.(subagent)}
      selected={selectedId === subagent.id}
      title={subagent.detail ?? subagent.label}
    >
      <ContextAvatar tone={tones.get(subagent.id) as 1 | 2 | 3}>
        <Bot aria-hidden="true" size={15} />
      </ContextAvatar>
      <ContextRowCopy
        detail={
          subagent.usage ? subagentUsageSummary(subagent.usage) : undefined
        }
        title={subagent.label}
      />
      <ContextStatus tone={statusToneOf(subagent.status)}>
        <SubagentStatusIcon status={subagent.status} />
        {t(`contextCard.subagentStatus.${subagent.status}`)}
      </ContextStatus>
    </ContextRow>
  );
  return (
    <ContextSection>
      <ContextHeading>{t("contextCard.subagents")}</ContextHeading>
      {onRetry ? (
        <Alert
          actions={
            <Button onClick={onRetry} size="sm">
              {t("common:actions.retry")}
            </Button>
          }
          className="mb-1.5"
          size="compact"
          title={t("contextCard.subagentsRefreshFailed")}
          tone="warning"
        />
      ) : null}
      <ContextList>
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
      </ContextList>
    </ContextSection>
  );
}
