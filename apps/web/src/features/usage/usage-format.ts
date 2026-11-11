import type { TFunction } from "i18next";
import type { UsageDimension, UsageTotals } from "./usage-model";

export function dimensionLabel(
  key: string,
  dimension: UsageDimension,
  {
    deviceLabels,
    t,
    userLabels,
    workspaceLabels,
  }: {
    deviceLabels: ReadonlyMap<string, string>;
    t: TFunction<["usage", "common"]>;
    userLabels: ReadonlyMap<string, string>;
    workspaceLabels: ReadonlyMap<string, string>;
  },
): string {
  if (key === "unknown") return t("dimensions.unknown");
  if (dimension === "device") return deviceLabels.get(key) ?? key;
  if (dimension === "workspace") return workspaceLabels.get(key) ?? key;
  if (dimension === "user") return userLabels.get(key) ?? key;
  if (dimension === "entry")
    return t(`entryValues.${key}`, { defaultValue: key });
  return key || t("dimensions.unknown");
}

export function sourceLabel(source: string, t: TFunction<"usage">): string {
  switch (source) {
    case "reported":
      return t("sources.reported");
    case "estimated":
      return t("sources.estimated");
    case "custom":
      return t("sources.custom");
    default:
      return t("sources.unknown");
  }
}

export function sourceShare(
  source: UsageTotals["costSources"][number],
  totals: UsageTotals,
): number {
  const turnTotal = totals.costSources.reduce(
    (sum, item) => sum + item.turns,
    0,
  );
  const basis = totals.costUsd > 0 ? totals.costUsd : turnTotal;
  const part = totals.costUsd > 0 ? source.costUsd : source.turns;
  return basis > 0 ? (part / basis) * 100 : 0;
}

export function compactNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    notation: "compact",
  }).format(value);
}

export function wholeNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(
    value,
  );
}

export function decimalNumber(
  value: number,
  locale: string,
  maximumFractionDigits: number,
): string {
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits,
    minimumFractionDigits: value < 10 ? Math.min(1, maximumFractionDigits) : 0,
  }).format(value);
}

export function currency(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    currency: "USD",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(value);
}

export function compactCurrency(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    currency: "USD",
    currencyDisplay: "narrowSymbol",
    maximumFractionDigits: 1,
    notation: "compact",
    style: "currency",
  }).format(value);
}
