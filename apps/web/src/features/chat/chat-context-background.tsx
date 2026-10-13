import {
  Activity,
  Bot,
  Check,
  CircleDashed,
  CircleStop,
  CircleX,
  Cog,
  LoaderCircle,
  Terminal,
  Workflow,
} from "lucide-react";
import type { AgentBackgroundTask } from "@bd777/foundry-protocol";
import { useTranslation } from "react-i18next";
import { i18n } from "../../i18n";
import { Button } from "../../components/ui/button";
import { formatDuration } from "../../components/conversation/turn-usage";
import { useSharedNow } from "../../lib/use-shared-now";
import {
  FinishedFold,
  finishedFoldLabel,
  useRevealedRow,
} from "./chat-context-folds";
import type {
  ChatBackgroundTaskItem,
  ChatContextSelection,
} from "./chat-types";

export function BackgroundKindIcon({
  kind,
  size = 16,
}: {
  kind: AgentBackgroundTask["kind"];
  size?: number;
}) {
  if (kind === "command") return <Terminal aria-hidden="true" size={size} />;
  if (kind === "monitor") return <Activity aria-hidden="true" size={size} />;
  if (kind === "workflow") return <Workflow aria-hidden="true" size={size} />;
  if (kind === "subagent") return <Bot aria-hidden="true" size={size} />;
  return <Cog aria-hidden="true" size={size} />;
}

export function BackgroundStatusIcon({
  status,
}: {
  status: AgentBackgroundTask["status"];
}) {
  if (status === "running")
    return <LoaderCircle aria-hidden="true" size={13} />;
  if (status === "completed") return <Check aria-hidden="true" size={13} />;
  if (status === "failed") return <CircleX aria-hidden="true" size={13} />;
  if (status === "stopped") return <CircleStop aria-hidden="true" size={13} />;
  return <CircleDashed aria-hidden="true" size={13} />;
}

function backgroundElapsed(task: AgentBackgroundTask, now: number): number {
  const started = Date.parse(task.startedAt);
  const ended = task.endedAt ? Date.parse(task.endedAt) : now;
  return Number.isNaN(started) || Number.isNaN(ended)
    ? 0
    : Math.max(0, ended - started);
}

/** How long it ran and how it ended: "running 23m", "failed · exit 144". */
function backgroundOutcome(task: AgentBackgroundTask, now: number): string {
  const duration = formatDuration(backgroundElapsed(task, now));
  const exit =
    task.exitCode !== undefined
      ? i18n.t("chat:contextCard.backgroundExit", { code: task.exitCode })
      : undefined;
  switch (task.status) {
    case "running":
      return i18n.t("chat:contextCard.backgroundRunningFor", { duration });
    case "completed":
      return [i18n.t("chat:contextCard.backgroundDoneIn", { duration }), exit]
        .filter(Boolean)
        .join(" · ");
    case "failed":
      return [i18n.t("chat:contextCard.backgroundFailed"), exit]
        .filter(Boolean)
        .join(" · ");
    case "stopped":
      return task.stopReason === "agent_exit"
        ? i18n.t("chat:contextCard.backgroundAgentExit")
        : i18n.t("chat:contextCard.backgroundStopped");
    default:
      return i18n.t("chat:contextCard.backgroundEnded");
  }
}

/** The row's second line: its kind in words, who started it, its outcome. */
export function backgroundRowDetail(
  item: ChatBackgroundTaskItem,
  now: number,
): string {
  return [
    i18n.t(`chat:contextCard.backgroundKind.${item.task.kind}`),
    item.ownerLabel
      ? i18n.t("chat:contextCard.backgroundFrom", { name: item.ownerLabel })
      : undefined,
    backgroundOutcome(item.task, now),
  ]
    .filter(Boolean)
    .join(" · ");
}

export function BackgroundSection({
  chatKey,
  items,
  onSelect,
  reveal,
  selectedId,
}: {
  chatKey?: string;
  items: ChatBackgroundTaskItem[];
  onSelect?: (item: ChatContextSelection) => void;
  reveal?: { ids: string[] };
  selectedId?: string;
}) {
  const { t } = useTranslation("chat");
  const running = items.filter((item) => item.task.status === "running");
  const finished = items.filter((item) => item.task.status !== "running");
  const backgroundFailed = finished.filter(
    (item) => item.task.status === "failed",
  ).length;
  const now = useSharedNow(running.length > 0);
  const rowRef = useRevealedRow(reveal);
  const row = (item: ChatBackgroundTaskItem) => (
    <Button
      aria-pressed={selectedId === item.id}
      className="fdy-chat-context-row"
      data-selected={selectedId === item.id ? "true" : "false"}
      data-status={item.task.status}
      key={item.id}
      ref={rowRef(item.id)}
      onClick={() => onSelect?.(item)}
      title={item.label}
      variant="ghost"
    >
      <span className="fdy-chat-context-row-icon" data-kind="background">
        <BackgroundKindIcon kind={item.task.kind} />
      </span>
      <span className="fdy-chat-context-row-copy">
        <strong>{item.label}</strong>
        <em>{backgroundRowDetail(item, now)}</em>
      </span>
      <span className="fdy-chat-context-status">
        <BackgroundStatusIcon status={item.task.status} />
        {t(`contextCard.backgroundStatus.${item.task.status}`)}
      </span>
    </Button>
  );
  return (
    <section className="fdy-chat-context-section">
      <h3>
        {t("contextCard.background")}
        {running.length > 0 ? (
          <span className="fdy-chat-context-count">{running.length}</span>
        ) : null}
      </h3>
      <div className="fdy-chat-context-list">
        {running.map(row)}
        {finished.length > 0 ? (
          <FinishedFold
            label={finishedFoldLabel(
              t("contextCard.backgroundFinished", { count: finished.length }),
              backgroundFailed > 0
                ? t("contextCard.foldFailed", { count: backgroundFailed })
                : undefined,
            )}
            memoryKey={chatKey && `${chatKey}:background`}
          >
            {finished.map(row)}
          </FinishedFold>
        ) : null}
      </div>
    </section>
  );
}
