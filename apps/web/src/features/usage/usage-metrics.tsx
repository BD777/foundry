import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Panel } from "../../components/ui/panel";
import { cn } from "../../lib/cn";
import { formatTimeToFirstToken } from "../../lib/format";
import type { UsageTotals } from "./usage-model";
import {
  compactCurrency,
  compactNumber,
  currency,
  decimalNumber,
  sourceLabel,
  sourceShare,
  wholeNumber,
} from "./usage-format";

export function UsageMetricGrid({
  hasData,
  locale,
  totals,
}: {
  hasData: boolean;
  locale: string;
  totals: UsageTotals;
}) {
  const { t } = useTranslation("usage");
  const number = (value: number) =>
    hasData ? compactNumber(value, locale) : t("states.noValue");
  const exactNumber = (value: number) => wholeNumber(value, locale);
  const exactCost = currency(totals.costUsd, locale);
  const speed =
    !hasData || totals.medianTokensPerSecond === undefined
      ? t("states.noValue")
      : t("metrics.tokensPerSecond", {
          value: decimalNumber(totals.medianTokensPerSecond, locale, 1),
        });
  const ttft =
    !hasData || totals.ttftP50Ms === undefined
      ? t("states.noValue")
      : (formatTimeToFirstToken(totals.ttftP50Ms) ?? t("states.noValue"));
  const sourceSummary = totals.costSources.length
    ? totals.costSources
        .map(
          (source) =>
            `${sourceLabel(source.source, t)} ${t("sources.share", {
              percent: decimalNumber(sourceShare(source, totals), locale, 1),
            })}`,
        )
        .join(" · ")
    : `${sourceLabel("unknown", t)} ${t("sources.share", {
        percent: decimalNumber(100, locale, 0),
      })}`;
  return (
    <section
      aria-label={t("page.title")}
      className="grid min-w-0 grid-cols-4 gap-2.5 max-[920px]:grid-cols-2 max-[560px]:grid-cols-1"
    >
      <MetricCard
        hint={!hasData ? t("states.noUsage") : undefined}
        label={t("metrics.turns")}
        title={exactNumber(totals.turns)}
        value={number(totals.turns)}
      />
      <MetricCard
        hint={!hasData ? t("states.noUsage") : undefined}
        label={t("metrics.requests")}
        title={exactNumber(totals.requests)}
        value={number(totals.requests)}
      />
      <MetricCard
        hint={!hasData ? t("states.noUsage") : undefined}
        label={t("metrics.inputTokens")}
        title={exactNumber(totals.inputTokens)}
        value={number(totals.inputTokens)}
      />
      <MetricCard
        hint={!hasData ? t("states.noUsage") : undefined}
        label={t("metrics.outputTokens")}
        title={exactNumber(totals.outputTokens)}
        value={number(totals.outputTokens)}
      />
      <MetricCard
        hint={
          hasData ? (
            <>
              <span>
                {t("metrics.estimatedShare", {
                  percent: decimalNumber(
                    totals.estimatedCostShare * 100,
                    locale,
                    1,
                  ),
                })}
              </span>
              <span className="block truncate" title={sourceSummary}>
                {sourceSummary}
              </span>
            </>
          ) : (
            t("states.noUsage")
          )
        }
        label={t("metrics.cost")}
        title={exactCost}
        value={
          hasData
            ? compactCurrency(totals.costUsd, locale)
            : t("states.noValue")
        }
      />
      <MetricCard
        hint={
          !hasData
            ? t("states.noUsage")
            : totals.medianTokensPerSecond === undefined
              ? t("metrics.noMeasurement")
              : undefined
        }
        label={t("metrics.medianSpeed")}
        title={speed}
        value={speed}
      />
      <MetricCard
        hint={
          !hasData
            ? t("states.noUsage")
            : totals.ttftP50Ms === undefined
              ? t("metrics.noMeasurement")
              : undefined
        }
        label={t("metrics.ttftP50")}
        title={ttft}
        value={ttft}
      />
    </section>
  );
}

function MetricCard({
  className,
  hint,
  label,
  title,
  value,
}: {
  className?: string;
  hint?: ReactNode;
  label: string;
  title: string;
  value: string;
}) {
  return (
    <Panel
      className={cn(
        "grid min-h-20 min-w-0 content-start gap-1.5 px-3 py-2.5",
        className,
      )}
      radius="md"
      variant="flat"
    >
      <span className="text-2xs leading-[1.35] font-semibold text-ink-muted">
        {label}
      </span>
      <span
        className="min-w-0 text-xl leading-none font-semibold text-ink wrap-anywhere"
        title={title}
      >
        {value}
      </span>
      {hint ? (
        <span className="min-w-0 text-2xs leading-[1.4] text-ink-muted">
          {hint}
        </span>
      ) : null}
    </Panel>
  );
}
