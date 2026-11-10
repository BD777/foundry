import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "../../components/ui/chart";
import { EmptyState } from "../../components/ui/empty-state";
import { SegmentedControl } from "../../components/ui/segmented-control";
import {
  formatBucket,
  groupedUsageTrend,
  type UsageDimension,
  type UsageGranularity,
  type UsageMetric,
  usageBuckets,
} from "./usage-model";

export interface UsageTrendProps {
  dimension: UsageDimension;
  dimensionName: string;
  from: Date;
  granularity: UsageGranularity;
  groupLabel: (key: string) => string;
  items: Parameters<typeof groupedUsageTrend>[0];
  to: Date;
}

const seriesColors = [
  "var(--fdy-accent)",
  "var(--fdy-success-text)",
  "var(--fdy-warning-text)",
  "var(--fdy-error-text)",
  "var(--fdy-info-text)",
  "var(--fdy-ink-muted)",
  "var(--fdy-accent-dark)",
];

export function UsageTrend({
  dimension,
  dimensionName,
  from,
  granularity,
  groupLabel,
  items,
  to,
}: UsageTrendProps) {
  const { t, i18n } = useTranslation("usage");
  const [metric, setMetric] = useState<UsageMetric>("turns");
  const buckets = useMemo(
    () => usageBuckets(from, to, granularity),
    [from, granularity, to],
  );
  const trend = useMemo(
    () =>
      groupedUsageTrend(
        items,
        dimension,
        metric,
        buckets,
        (key) => (key === "other" ? t("trend.other") : groupLabel(key)),
      ),
    [buckets, dimension, groupLabel, items, metric, t],
  );
  const chartConfig = useMemo<ChartConfig>(
    () =>
      Object.fromEntries(
        trend.series.map((series, index) => [
          series.key,
          {
            color: seriesColors[index % seriesColors.length],
            label: series.label,
          },
        ]),
      ),
    [trend.series],
  );
  const chartData = useMemo(
    () =>
      trend.data.map((row) => ({
        ...row,
        label: formatBucket(row.bucket, granularity, i18n.language),
      })),
    [granularity, i18n.language, trend.data],
  );
  const formatValue = (value: number) =>
    metricValue(metric, value, i18n.language);
  const metricOptions: Array<{ label: string; value: UsageMetric }> = [
    { label: t("metrics.turns"), value: "turns" },
    { label: t("trend.metricTokens"), value: "tokens" },
    { label: t("metrics.cost"), value: "cost" },
    { label: t("metrics.requests"), value: "requests" },
  ];
  return (
    <div className="grid min-w-0 gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-2xs font-semibold text-ink-muted">
          {t("trend.metric")}
        </span>
        <SegmentedControl
          aria-label={t("trend.metric")}
          onValueChange={setMetric}
          options={metricOptions}
          size="sm"
          value={metric}
        />
      </div>
      {trend.series.length === 0 || chartData.length === 0 ? (
        <EmptyState
          body={t("trend.emptyBody")}
          title={t("trend.emptyTitle")}
        />
      ) : (
        <figure
          aria-label={t("trend.chartLabel")}
          className="m-0 grid min-w-0 gap-1"
          data-chart-kind={chartData.length === 1 ? "bars" : "areas"}
          data-usage-trend="drawn"
        >
          <ChartContainer
            className="h-[260px] min-h-[260px] w-full min-w-0"
            config={chartConfig}
          >
            {chartData.length === 1 ? (
              <BarChart
                accessibilityLayer
                data={chartData}
                margin={{ bottom: 4, left: 0, right: 8, top: 8 }}
              >
                <CartesianGrid
                  stroke="var(--fdy-line-soft)"
                  strokeDasharray="3 4"
                  vertical={false}
                />
                <XAxis
                  axisLine={false}
                  dataKey="label"
                  tickLine={false}
                  tickMargin={8}
                />
                <YAxis
                  axisLine={false}
                  tickFormatter={(value: number) =>
                    compactMetric(metric, value, i18n.language)
                  }
                  tickLine={false}
                  tickMargin={4}
                  width={58}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      indicator="dot"
                      valueFormatter={(value) => formatValue(Number(value))}
                    />
                  }
                />
                <ChartLegend content={<ChartLegendContent />} />
                {trend.series.map((series) => (
                  <Bar
                    dataKey={series.key}
                    fill={`var(--color-${series.key})`}
                    isAnimationActive={false}
                    key={series.key}
                    maxBarSize={64}
                    stackId="usage"
                  />
                ))}
              </BarChart>
            ) : (
              <AreaChart
                accessibilityLayer
                data={chartData}
                margin={{ bottom: 4, left: 0, right: 8, top: 8 }}
              >
                <CartesianGrid
                  stroke="var(--fdy-line-soft)"
                  strokeDasharray="3 4"
                  vertical={false}
                />
                <XAxis
                  axisLine={false}
                  dataKey="label"
                  minTickGap={20}
                  tickLine={false}
                  tickMargin={8}
                />
                <YAxis
                  axisLine={false}
                  tickFormatter={(value: number) =>
                    compactMetric(metric, value, i18n.language)
                  }
                  tickLine={false}
                  tickMargin={4}
                  width={58}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      indicator="dot"
                      valueFormatter={(value) => formatValue(Number(value))}
                    />
                  }
                />
                <ChartLegend content={<ChartLegendContent />} />
                {trend.series.map((series) => (
                  <Area
                    activeDot={{ r: 3 }}
                    dataKey={series.key}
                    dot={false}
                    fill={`var(--color-${series.key})`}
                    fillOpacity={0.22}
                    isAnimationActive={false}
                    key={series.key}
                    stackId="usage"
                    stroke={`var(--color-${series.key})`}
                    strokeWidth={2}
                    type="linear"
                  />
                ))}
              </AreaChart>
            )}
          </ChartContainer>
          <figcaption className="sr-only">
            {t("trend.description", {
              dimension: dimensionName,
            })}
          </figcaption>
        </figure>
      )}
    </div>
  );
}

function metricValue(
  metric: UsageMetric,
  value: number,
  locale: string,
): string {
  if (metric === "cost")
    return new Intl.NumberFormat(locale, {
      currency: "USD",
      maximumFractionDigits: 2,
      minimumFractionDigits: 2,
      style: "currency",
    }).format(value);
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
  }).format(value);
}

function compactMetric(
  metric: UsageMetric,
  value: number,
  locale: string,
): string {
  if (metric === "cost")
    return new Intl.NumberFormat(locale, {
      currency: "USD",
      currencyDisplay: "narrowSymbol",
      maximumFractionDigits: 1,
      notation: "compact",
      style: "currency",
    }).format(value);
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    notation: "compact",
  }).format(value);
}
