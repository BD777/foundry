import type { AgentTurnUsage, SubagentUsage } from "@bd777/foundry-protocol";
import type { StepUsage } from "./conversation-types";
import { useTranslation } from "react-i18next";
import { i18n } from "../../i18n";
import { Button } from "../ui/button";
import { Popover } from "../ui/popover";

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return i18n.t("conversation:usage.hours", { hours, minutes });
  if (minutes > 0)
    return i18n.t("conversation:usage.minutes", { minutes, seconds });
  return i18n.t("conversation:usage.seconds", { seconds });
}

export function formatTokenCount(count: number): string {
  return new Intl.NumberFormat(i18n.language, {
    maximumFractionDigits: 1,
    notation: "compact",
  }).format(count);
}

function formatShare(part: number, total: number): string {
  return new Intl.NumberFormat(i18n.language, {
    maximumFractionDigits: 0,
    style: "percent",
  }).format(total > 0 ? part / total : 0);
}

/** One line for the turn, with the full breakdown one click away. */
export function turnUsageSummary(usage: AgentTurnUsage): string {
  return [formatDuration(usage.durationMs), ...tokenParts(usage)].join(" · ");
}

/** Whether a report counts any tokens; relays sometimes report only zeros. */
export function countsTokens(usage: {
  inputTokens: number;
  outputTokens: number;
}): boolean {
  return usage.inputTokens > 0 || usage.outputTokens > 0;
}

function tokenParts(usage: {
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}): string[] {
  if (!countsTokens(usage)) return [];
  return [
    usage.cacheReadTokens > 0
      ? i18n.t("conversation:usage.inputCached", {
          count: formatTokenCount(usage.inputTokens),
          share: formatShare(usage.cacheReadTokens, usage.inputTokens),
        })
      : i18n.t("conversation:usage.inputShort", {
          count: formatTokenCount(usage.inputTokens),
        }),
    i18n.t("conversation:usage.outputShort", {
      count: formatTokenCount(usage.outputTokens),
    }),
  ];
}

/** The tokens of a process group's model requests, e.g. "12K in · 800 out". */
export function stepUsageSummary(usage: StepUsage): string {
  return tokenParts(usage).join(" · ");
}

/** What a group's token counts cover, for its tooltip. */
export function stepUsageTitle(usage: StepUsage): string {
  return i18n.t("conversation:usage.stepsTitle", { count: usage.requests });
}

/** A subagent's own work: Claude reports one token total for it. */
export function subagentUsageSummary(usage: SubagentUsage): string {
  return [
    ...(usage.totalTokens > 0
      ? [
          i18n.t("conversation:usage.totalShort", {
            count: formatTokenCount(usage.totalTokens),
          }),
        ]
      : []),
    i18n.t("conversation:usage.toolUses", { count: usage.toolUses }),
    ...(usage.durationMs > 0 ? [formatDuration(usage.durationMs)] : []),
  ].join(" · ");
}

export function TurnUsage({ usage }: { usage: AgentTurnUsage }) {
  const { t } = useTranslation("conversation");
  const exact = new Intl.NumberFormat(i18n.language);
  const uncached = Math.max(
    0,
    usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens,
  );
  const share = formatShare(usage.cacheReadTokens, usage.inputTokens);
  const rows: { label: string; value?: number | string; part?: boolean }[] = [
    { label: t("usage.duration"), value: formatDuration(usage.durationMs) },
    { label: t("usage.modelRequests"), value: usage.modelRequests },
    { label: t("usage.input"), value: usage.inputTokens },
    {
      label: t("usage.cacheRead"),
      value: `${exact.format(usage.cacheReadTokens)} (${share})`,
      part: true,
    },
    {
      label: t("usage.cacheWrite"),
      value: usage.cacheWriteTokens || undefined,
      part: true,
    },
    { label: t("usage.uncached"), value: uncached, part: true },
    { label: t("usage.output"), value: usage.outputTokens },
    {
      label: t("usage.reasoning"),
      value: usage.reasoningTokens || undefined,
      part: true,
    },
  ];
  return (
    <Popover
      className="fdy-turn-usage-panel"
      trigger={
        <Button className="fdy-turn-usage-trigger" size="sm" variant="ghost">
          <span className="fdy-turn-usage-summary">
            {turnUsageSummary(usage)}
          </span>
        </Button>
      }
    >
      <dl aria-label={t("usage.details")} className="fdy-turn-usage-list">
        {rows
          .filter(
            (row) =>
              row.value !== undefined &&
              (countsTokens(usage) || row === rows[0] || row === rows[1]),
          )
          .map(({ label, value, part }) => (
            <div data-part={part ? "true" : "false"} key={label}>
              <dt>{label}</dt>
              <dd>{typeof value === "number" ? exact.format(value) : value}</dd>
            </div>
          ))}
      </dl>
      <p className="fdy-turn-usage-note">{t("usage.turnScope")}</p>
    </Popover>
  );
}
