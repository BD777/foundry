import type {
  UsageStatsCostSource,
  UsageStatsDimension,
  UsageStatsGranularity,
  UsageStatsPoint,
} from "@bd777/foundry-protocol";

export type UsageRangePreset = "today" | "sevenDays" | "thirtyDays" | "custom";
export type UsageDimension = UsageStatsDimension;
export type UsageGranularity = UsageStatsGranularity;
export type UsageMetric = "turns" | "tokens" | "cost" | "requests";

export interface UsageRange {
  from: Date;
  to: Date;
}

export interface UsageTotals {
  costSources: UsageStatsCostSource[];
  costUsd: number;
  estimatedCostShare: number;
  inputTokens: number;
  medianTokensPerSecond?: number;
  outputTokens: number;
  requests: number;
  ttftP50Ms?: number;
  turns: number;
}

export interface UsageBreakdownRow extends UsageTotals {
  bucketCount: number;
  key: string;
}

export interface UsageTrendSeries {
  key: string;
  label: string;
  total: number;
}

export interface UsageTrendRow {
  bucket: string;
  [key: string]: string | number;
}

export const usageDimensions: UsageDimension[] = [
  "entry",
  "device",
  "workspace",
  "provider",
  "model",
  "runtime",
  "user",
];

export const costSourceOrder = [
  "reported",
  "estimated",
  "custom",
  "unknown",
] as const;

export function localDayStart(date: Date): Date {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    0,
    0,
    0,
    0,
  );
}

export function addLocalDays(date: Date, days: number): Date {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + days,
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  );
}

export function dateInputValue(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function dateFromInput(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 0, 0, 0, 0);
  return date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
    ? date
    : undefined;
}

export function usageRange(
  preset: UsageRangePreset,
  now: Date,
  customFrom?: string,
  customTo?: string,
): UsageRange | undefined {
  const today = localDayStart(now);
  switch (preset) {
    case "today":
      return { from: today, to: now };
    case "sevenDays":
      return { from: addLocalDays(today, -6), to: now };
    case "thirtyDays":
      return { from: addLocalDays(today, -29), to: now };
    case "custom": {
      const from = customFrom ? dateFromInput(customFrom) : undefined;
      const through = customTo ? dateFromInput(customTo) : undefined;
      if (!from || !through || from > through) return undefined;
      return { from, to: addLocalDays(through, 1) };
    }
  }
}

export function hourlyUsageAvailable(from: Date, now: Date): boolean {
  return from.getTime() >= addLocalDays(localDayStart(now), -89).getTime();
}

/** Every UTC bucket the query can return across its selected range. */
export function usageBuckets(
  from: Date,
  to: Date,
  granularity: UsageGranularity,
): string[] {
  if (to <= from) return [];
  const buckets: string[] = [];
  const cursor = new Date(from);
  if (granularity === "day") {
    cursor.setUTCHours(0, 0, 0, 0);
    while (cursor < to) {
      buckets.push(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return buckets;
  }
  cursor.setUTCMinutes(0, 0, 0);
  while (cursor < to) {
    buckets.push(`${cursor.toISOString().slice(0, 13)}:00:00Z`);
    cursor.setUTCHours(cursor.getUTCHours() + 1);
  }
  return buckets;
}

export function aggregateUsage(items: readonly UsageStatsPoint[]): UsageTotals {
  const costSources = new Map<
    UsageStatsCostSource["source"],
    UsageStatsCostSource
  >();
  let turns = 0;
  let requests = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  for (const item of items) {
    turns += item.turns;
    requests += item.requests;
    inputTokens += item.inputTokens;
    outputTokens += item.outputTokens;
    costUsd += item.costUsd;
    for (const source of item.costSources) {
      const current = costSources.get(source.source);
      if (current) {
        current.turns += source.turns;
        current.costUsd += source.costUsd;
      } else {
        costSources.set(source.source, { ...source });
      }
    }
  }
  const sources = [...costSources.values()].sort(
    (left, right) =>
      costSourceOrder.indexOf(left.source) -
      costSourceOrder.indexOf(right.source),
  );
  const estimated = sources.find((source) => source.source === "estimated");
  return {
    costSources: sources,
    costUsd,
    estimatedCostShare:
      costUsd > 0 ? Math.min(1, (estimated?.costUsd ?? 0) / costUsd) : 0,
    inputTokens,
    medianTokensPerSecond: weightedMedian(
      items.map((item) => ({
        value: item.medianTokensPerSecond,
        weight: item.requests || item.turns,
      })),
    ),
    outputTokens,
    requests,
    ttftP50Ms: weightedMedian(
      items.map((item) => ({
        value: item.ttftP50Ms,
        weight: item.requests || item.turns,
      })),
    ),
    turns,
  };
}

export function groupUsage(
  items: readonly UsageStatsPoint[],
  dimension: UsageDimension,
): UsageBreakdownRow[] {
  const groups = new Map<
    string,
    { buckets: Set<string>; items: UsageStatsPoint[] }
  >();
  for (const item of items) {
    const key = dimensionValue(item, dimension) || "unknown";
    const group = groups.get(key) ?? { buckets: new Set<string>(), items: [] };
    group.items.push(item);
    group.buckets.add(item.bucket);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([key, group]) => ({
      ...aggregateUsage(group.items),
      bucketCount: group.buckets.size,
      key,
    }))
    .sort(
      (left, right) =>
        right.costUsd - left.costUsd ||
        right.turns - left.turns ||
        right.requests - left.requests ||
        left.key.localeCompare(right.key),
    );
}

export function dimensionValue(
  point: UsageStatsPoint,
  dimension: UsageDimension,
): string {
  switch (dimension) {
    case "entry":
      return point.entry ?? "";
    case "device":
      return point.deviceId ?? "";
    case "workspace":
      return point.workspaceId ?? "";
    case "provider":
      return point.provider ?? "";
    case "model":
      return point.model ?? "";
    case "runtime":
      return point.runtime ?? "";
    case "user":
      return point.userId ?? "";
  }
}

export function groupedUsageTrend(
  items: readonly UsageStatsPoint[],
  dimension: UsageDimension,
  metric: UsageMetric,
  buckets: readonly string[],
  labelFor: (key: string) => string,
  maximumSeries = 6,
): { data: UsageTrendRow[]; series: UsageTrendSeries[] } {
  const bucketSet = new Set(buckets);
  const visibleItems = items.filter((item) => bucketSet.has(item.bucket));
  const totals = new Map<string, number>();
  for (const item of visibleItems) {
    const key = dimensionValue(item, dimension) || "unknown";
    totals.set(key, (totals.get(key) ?? 0) + usageMetricValue(item, metric));
  }
  const ranked = [...totals.entries()]
    .filter(([, total]) => total > 0)
    .sort(
      ([leftKey, left], [rightKey, right]) =>
        right - left || leftKey.localeCompare(rightKey),
    );
  const visible = ranked.slice(0, maximumSeries);
  const remaining = ranked.slice(maximumSeries);
  const series: UsageTrendSeries[] = visible.map(
    ([groupKey, total], index) => ({
      key: `series${index}`,
      label: labelFor(groupKey),
      total,
    }),
  );
  const otherTotal = remaining.reduce((sum, [, total]) => sum + total, 0);
  if (otherTotal > 0) {
    series.push({
      key: "seriesOther",
      label: labelFor("other"),
      total: otherTotal,
    });
  }
  if (series.length === 0) return { data: [], series: [] };

  const keys = new Map(
    visible.map(([groupKey], index) => [groupKey, `series${index}`]),
  );
  const byBucket = new Map(
    buckets.map((bucket) => {
      const row: UsageTrendRow = { bucket };
      for (const item of series) row[item.key] = 0;
      return [bucket, row] as const;
    }),
  );
  for (const item of visibleItems) {
    const value = usageMetricValue(item, metric);
    if (value <= 0) continue;
    const groupKey = dimensionValue(item, dimension) || "unknown";
    const seriesKey = keys.get(groupKey) ?? "seriesOther";
    const row = byBucket.get(item.bucket);
    if (!row) continue;
    row[seriesKey] = Number(row[seriesKey] ?? 0) + value;
  }
  return {
    data: buckets.flatMap((bucket) => {
      const row = byBucket.get(bucket);
      return row ? [row] : [];
    }),
    series,
  };
}

function usageMetricValue(item: UsageStatsPoint, metric: UsageMetric): number {
  switch (metric) {
    case "turns":
      return item.turns;
    case "tokens":
      return item.inputTokens + item.outputTokens;
    case "cost":
      return item.costUsd;
    case "requests":
      return item.requests;
  }
}

export function bucketDate(
  bucket: string,
  granularity: UsageGranularity,
): Date | undefined {
  if (granularity === "day") return dateFromInput(bucket);
  const date = new Date(bucket);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function formatBucket(
  bucket: string,
  granularity: UsageGranularity,
  locale: string,
): string {
  const date = bucketDate(bucket, granularity);
  if (!date) return bucket;
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    hour: granularity === "hour" ? "2-digit" : undefined,
    minute: granularity === "hour" ? "2-digit" : undefined,
    month: "short",
  }).format(date);
}

function weightedMedian(
  entries: Array<{ value: number | undefined; weight: number }>,
): number | undefined {
  const values = entries
    .filter(
      (entry): entry is { value: number; weight: number } =>
        entry.value !== undefined &&
        Number.isFinite(entry.value) &&
        entry.weight > 0,
    )
    .sort((left, right) => left.value - right.value);
  const total = values.reduce((sum, entry) => sum + entry.weight, 0);
  if (total <= 0) return undefined;
  const target = total / 2;
  let cumulative = 0;
  for (const entry of values) {
    cumulative += entry.weight;
    if (cumulative >= target) return entry.value;
  }
  return values.at(-1)?.value;
}
