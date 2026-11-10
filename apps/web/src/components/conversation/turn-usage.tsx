import type { AgentTurnUsage, SubagentUsage } from "@bd777/foundry-protocol";
import type { StepUsage } from "./conversation-types";
import { useTranslation } from "react-i18next";
import { i18n } from "../../i18n";
import { cn } from "../../lib/cn";
import {
  formatDuration,
  formatOutputSpeed,
  formatTimeToFirstToken,
  formatUsageDuration,
} from "../../lib/format";
import { Button } from "../ui/button";
import { Popover } from "../ui/popover";

export { formatDuration };

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

type TurnUsageWithTiming = AgentTurnUsage & {
  modelMs?: number;
  ttftMs?: number;
  /** Added to the contract for estimated Codex timings. */
  timingEstimated?: boolean;
};

function timingIsEstimated(usage: TurnUsageWithTiming): boolean {
  return usage.timingEstimated === true;
}

/** One line for the turn, with the full breakdown one click away. */
export function turnUsageSummary(usage: AgentTurnUsage): string {
  const timed = usage as TurnUsageWithTiming;
  const parts = tokenParts(usage);
  const speed = formatOutputSpeed(
    usage.outputTokens,
    timed.modelMs ?? 0,
    timingIsEstimated(timed),
  );
  if (speed) parts.push(speed);
  return [formatDuration(usage.durationMs), ...parts].join(" · ");
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
  const parts = tokenParts(usage);
  const speed = formatOutputSpeed(usage.outputTokens, usage.generationMs ?? 0);
  if (speed) parts.push(speed);
  return parts.join(" · ");
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
  const timed = usage as TurnUsageWithTiming;
  const estimated = timingIsEstimated(timed);
  const approximate = (value: string) => (estimated ? `≈${value}` : value);
  const uncached = Math.max(
    0,
    usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens,
  );
  const share = formatShare(usage.cacheReadTokens, usage.inputTokens);
  const modelMs =
    timed.modelMs !== undefined &&
    Number.isFinite(timed.modelMs) &&
    timed.modelMs >= 0
      ? timed.modelMs
      : undefined;
  const otherMs =
    modelMs === undefined ? undefined : Math.max(0, usage.durationMs - modelMs);
  const outputSpeed = formatOutputSpeed(
    usage.outputTokens,
    modelMs ?? 0,
    estimated,
  );
  const rows: {
    label: string;
    value?: number | string;
    part?: boolean;
    always?: boolean;
  }[] = [
    {
      label: t("usage.duration"),
      value: formatDuration(usage.durationMs),
      always: true,
    },
    ...(modelMs === undefined
      ? []
      : [
          {
            label: t("usage.modelTime"),
            value: approximate(formatUsageDuration(modelMs)),
            always: true,
          },
          {
            label: t("usage.toolsAndOther"),
            value: approximate(formatUsageDuration(otherMs ?? 0)),
            always: true,
          },
        ]),
    ...(timed.ttftMs === undefined
      ? []
      : [
          {
            label: t("usage.timeToFirstToken"),
            value: formatTimeToFirstToken(timed.ttftMs, estimated),
            always: true,
          },
        ]),
    ...(outputSpeed === undefined
      ? []
      : [
          {
            label: t("usage.outputSpeed"),
            value: outputSpeed,
            always: true,
          },
        ]),
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
      trigger={
        <Button
          className="h-6 max-w-full min-w-0 px-1.5 text-[length:inherit] font-medium text-inherit tabular-nums hover:text-ink data-[state=open]:text-ink"
          size="sm"
          variant="ghost"
        >
          <span className="min-w-0 truncate">{turnUsageSummary(usage)}</span>
        </Button>
      }
    >
      <dl aria-label={t("usage.details")} className="grid gap-[3px]">
        {rows
          .filter(
            (row) =>
              row.value !== undefined && (countsTokens(usage) || row.always),
          )
          .map(({ label, value, part }) => (
            <div
              className={cn(
                "flex justify-between gap-6",
                part && "pl-3 font-medium text-(--fdy-dark-muted)",
              )}
              data-part={part ? "true" : "false"}
              key={label}
            >
              <dt>{label}</dt>
              <dd className="tabular-nums">
                {typeof value === "number" ? exact.format(value) : value}
              </dd>
            </div>
          ))}
      </dl>
      <p className="mt-2 max-w-60 font-medium whitespace-normal">
        {t("usage.turnScope")}
      </p>
    </Popover>
  );
}
