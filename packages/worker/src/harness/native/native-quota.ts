/** Native quota responses only. Never derive account quota from session tokens. */
import type { NativeAccountUsage } from "@bd777/foundry-protocol";

const record = (value: unknown): Record<string, any> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : undefined;
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim()
    ? value.trim().slice(0, 160)
    : undefined;
const percent = (value: unknown): number | undefined =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 100
    ? value
    : undefined;
const positive = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;

export function codexQuotaWindows(result: unknown): NativeAccountUsage[] {
  const response = record(result);
  const buckets = record(response?.rateLimitsByLimitId);
  const legacy = record(response?.rateLimits);
  const entries =
    buckets && Object.keys(buckets).length
      ? Object.entries(buckets)
      : legacy
        ? [[text(legacy.limitId) ?? "codex", legacy] as const]
        : [];
  return entries.flatMap(([key, value]) => {
    const bucket = record(value);
    if (!bucket) return [];
    return ["primary", "secondary"].flatMap((slot) => {
      const window = record(bucket[slot]);
      if (!window) return [];
      return [
        {
          id: `${key}:${slot}`,
          label:
            text(bucket.limitName) ?? (key === "codex" ? undefined : text(key)),
          usedPercent: percent(window.usedPercent),
          windowMinutes: positive(window.windowDurationMins),
          resetsAt: positive(window.resetsAt),
        },
      ];
    });
  });
}

export function claudeQuotaWindows(result: unknown): NativeAccountUsage[] {
  const response = record(result);
  if (response?.rate_limits_available !== true) return [];
  const limits = record(response.rate_limits);
  if (!limits) return [];
  const windows: NativeAccountUsage[] = [];
  const append = (
    id: string,
    value: unknown,
    windowMinutes?: number,
    label?: string,
  ) => {
    const window = record(value);
    if (!window) return;
    const reset =
      typeof window.resets_at === "string"
        ? Date.parse(window.resets_at) / 1000
        : undefined;
    windows.push({
      id,
      label,
      usedPercent: percent(window.utilization),
      windowMinutes,
      resetsAt: positive(reset),
    });
  };
  // Durations are defined by the SDK fields, never guessed from a model name.
  append("five_hour", limits.five_hour, 300);
  append("seven_day", limits.seven_day, 10080);
  append(
    "seven_day_oauth_apps",
    limits.seven_day_oauth_apps,
    10080,
    "OAuth apps",
  );
  append("seven_day_opus", limits.seven_day_opus, 10080, "Opus");
  append("seven_day_sonnet", limits.seven_day_sonnet, 10080, "Sonnet");
  if (Array.isArray(limits.model_scoped)) {
    const names = new Map<string, number>();
    for (const row of limits.model_scoped) {
      const label = text(row?.display_name);
      if (!label) continue;
      const count = names.get(label) ?? 0;
      names.set(label, count + 1);
      append(`model:${label}:${count}`, row, 10080, label);
    }
  }
  if (limits.extra_usage?.is_enabled === true) {
    append("extra_usage", limits.extra_usage);
  }
  return windows;
}
