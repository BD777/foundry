import type {
  UsageStatsDimension,
  UsageStatsResult,
} from "@bd777/foundry-protocol";
import type { TFunction } from "i18next";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { getUsageStats, listUsers } from "../../api";
import type { AccountUser } from "../../api-types";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { FieldHint, TextInput } from "../../components/ui/field";
import { Skeleton, Spinner } from "../../components/ui/loading";
import { PageHeader, SectionHeader } from "../../components/ui/page-header";
import { PageSurface } from "../../components/ui/page-surface";
import { Panel } from "../../components/ui/panel";
import {
  RecordsBody,
  RecordsCell,
  RecordsHead,
  RecordsHeaderCell,
  RecordsRow,
  RecordsTable,
} from "../../components/ui/records-table";
import { SegmentedControl } from "../../components/ui/segmented-control";
import { SelectMenu } from "../../components/ui/select-menu";
import { cn } from "../../lib/cn";
import { serverErrorText } from "../../lib/errors";
import { formatTimeToFirstToken } from "../../lib/format";
import {
  addLocalDays,
  aggregateUsage,
  dateInputValue,
  groupUsage,
  hourlyUsageAvailable,
  type UsageBreakdownRow,
  type UsageDimension,
  type UsageGranularity,
  type UsageRangePreset,
  type UsageTotals,
  usageDimensions,
  usageRange,
} from "./usage-model";
import { UsageTrend } from "./usage-trend";

export interface UsageFeatureProps {
  currentUser?: AccountUser;
  devices: readonly { id: string; label: string }[];
  isAdmin: boolean;
  workspaces: readonly { id: string; name: string }[];
}

interface UsageData {
  breakdown: UsageStatsResult;
  overview: UsageStatsResult;
}

const rangeOptions: UsageRangePreset[] = [
  "today",
  "sevenDays",
  "thirtyDays",
  "custom",
];

export function UsageFeature({
  currentUser,
  devices,
  isAdmin,
  workspaces,
}: UsageFeatureProps) {
  const { t, i18n } = useTranslation(["usage", "common"]);
  const today = dateInputValue(new Date());
  const [rangePreset, setRangePreset] =
    useState<UsageRangePreset>("sevenDays");
  const [customFrom, setCustomFrom] = useState(() =>
    dateInputValue(addLocalDays(new Date(), -6)),
  );
  const [customTo, setCustomTo] = useState(today);
  const [granularity, setGranularity] =
    useState<UsageGranularity>("day");
  const [dimension, setDimension] = useState<UsageDimension>("entry");
  const [selectedUserId, setSelectedUserId] = useState("");
  const [users, setUsers] = useState<AccountUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [userError, setUserError] = useState("");
  const [data, setData] = useState<UsageData>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  const range = useMemo(
    () => usageRange(rangePreset, new Date(), customFrom, customTo),
    [customFrom, customTo, rangePreset],
  );
  const hourlyAvailable = range
    ? hourlyUsageAvailable(range.from, new Date())
    : false;
  const customInvalid = rangePreset === "custom" && !range;
  const deviceLabels = useMemo(
    () => new Map(devices.map((device) => [device.id, device.label])),
    [devices],
  );
  const workspaceLabels = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace.name])),
    [workspaces],
  );
  const userLabels = useMemo(() => {
    const labels = new Map(users.map((user) => [user.id, user.displayName]));
    if (currentUser) labels.set(currentUser.id, currentUser.displayName);
    return labels;
  }, [currentUser, users]);

  useEffect(() => {
    if (!isAdmin) {
      setUsers([]);
      setSelectedUserId("");
      setUserError("");
      setUsersLoading(false);
      return;
    }
    let cancelled = false;
    setUsersLoading(true);
    listUsers()
      .then((nextUsers) => {
        if (!cancelled) {
          setUsers(nextUsers);
          setUserError("");
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setUserError(serverErrorText(cause));
      })
      .finally(() => {
        if (!cancelled) setUsersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  useEffect(() => {
    if (!range) {
      setData(undefined);
      setLoading(false);
      setError("");
      return;
    }
    if (granularity === "hour" && !hourlyAvailable) {
      setGranularity("day");
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const query = {
      from: range.from,
      to: range.to,
      granularity,
      signal: controller.signal,
      userId: isAdmin ? selectedUserId || undefined : undefined,
    } as const;
    Promise.all([
      getUsageStats({ ...query, groupBy: [] }),
      getUsageStats({ ...query, groupBy: [dimension] }),
    ])
      .then(([overview, breakdown]) => {
        setData({ breakdown, overview });
      })
      .catch((cause: unknown) => {
        if (
          !(cause instanceof DOMException && cause.name === "AbortError")
        ) {
          setData(undefined);
          setError(serverErrorText(cause));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [
    dimension,
    granularity,
    hourlyAvailable,
    isAdmin,
    range,
    reloadKey,
    selectedUserId,
  ]);

  const overview = data ? aggregateUsage(data.overview.items) : undefined;
  const rows = useMemo(
    () => (data ? groupUsage(data.breakdown.items, dimension) : []),
    [data, dimension],
  );
  const locale = i18n.language;
  const dimensionName = t(`dimensions.${dimension}`);
  const scopeLabel = isAdmin ? t("page.adminScope") : t("page.selfScope");

  function chooseRange(nextRange: UsageRangePreset): void {
    setRangePreset(nextRange);
    if (nextRange === "today") setGranularity("hour");
    else if (nextRange !== "custom") setGranularity("day");
  }

  return (
    <PageSurface aria-busy={loading} variant="usage">
      <PageHeader title={t("page.title")} description={t("page.intro")} />

      <section
        aria-label={t("filters.label")}
        className="grid min-w-0 gap-3 border-y border-line py-3.5"
      >
        <div className="flex min-w-0 flex-wrap items-end gap-x-4 gap-y-3">
          <FilterField label={t("filters.range")}>
            <SegmentedControl
              aria-label={t("filters.range")}
              onValueChange={chooseRange}
              options={rangeOptions.map((value) => ({
                label: t(`ranges.${value}`),
                value,
              }))}
              size="sm"
              value={rangePreset}
            />
          </FilterField>
          <FilterField label={t("filters.granularity")}>
            <SegmentedControl
              aria-label={t("filters.granularity")}
              onValueChange={setGranularity}
              options={[
                {
                  disabled: !hourlyAvailable,
                  label: t("granularities.hour"),
                  value: "hour",
                },
                { label: t("granularities.day"), value: "day" },
              ]}
              size="sm"
              value={granularity}
            />
          </FilterField>
          <FilterField label={t("filters.groupBy")}>
            <SelectMenu
              ariaLabel={t("filters.groupBy")}
              className="min-w-36"
              onChange={(value) => setDimension(value as UsageStatsDimension)}
              options={usageDimensions.map((value) => ({
                label: t(`dimensions.${value}`),
                value,
              }))}
              value={dimension}
            />
          </FilterField>
          {isAdmin ? (
            <FilterField label={t("filters.user")}>
              <SelectMenu
                ariaLabel={t("filters.user")}
                className="min-w-44"
                disabled={usersLoading}
                onChange={setSelectedUserId}
                options={[
                  { label: t("filters.allUsers"), value: "" },
                  ...users.map((user) => ({
                    detail: user.disabledAt ? user.username : undefined,
                    label: user.displayName,
                    meta: user.username,
                    value: user.id,
                  })),
                ]}
                placeholder={
                  usersLoading ? t("filters.loadingUsers") : t("filters.user")
                }
                value={selectedUserId}
              />
            </FilterField>
          ) : (
            <Badge className="mb-1" tone="neutral">
              {scopeLabel}
            </Badge>
          )}
          {loading ? (
            <Spinner
              className="mb-1.5"
              label={data ? t("states.refreshing") : t("states.loading")}
            />
          ) : null}
        </div>

        {rangePreset === "custom" ? (
          <div className="flex min-w-0 flex-wrap items-end gap-3">
            <DateField
              label={t("filters.customFrom")}
              max={customTo}
              onChange={setCustomFrom}
              value={customFrom}
            />
            <DateField
              label={t("filters.customTo")}
              max={today}
              onChange={setCustomTo}
              value={customTo}
            />
          </div>
        ) : null}
        {customInvalid ? (
          <FieldHint tone="error">{t("filters.customInvalid")}</FieldHint>
        ) : null}
        {!hourlyAvailable && rangePreset !== "custom" ? (
          <FieldHint>{t("filters.hourRange")}</FieldHint>
        ) : null}
        {isAdmin ? (
          <Badge className="w-max" tone="neutral">
            {scopeLabel}
          </Badge>
        ) : null}
      </section>

      {userError ? (
        <Alert size="compact" title={t("states.userLoadFailed")} tone="warning">
          {userError}
        </Alert>
      ) : null}
      {error ? (
        <Alert
          actions={
            <Button
              onClick={() => setReloadKey((current) => current + 1)}
              size="sm"
              variant="secondary"
            >
              {t("common:actions.retry")}
            </Button>
          }
          title={t("states.failedTitle")}
          tone="error"
        >
          {error}
        </Alert>
      ) : null}
      {customInvalid ? (
        <Alert size="compact" title={t("filters.customInvalid")} tone="warning" />
      ) : null}
      {loading && !data && !error ? (
        <Skeleton label={t("states.loading")} rows={6} variant="lines" />
      ) : null}
      {!loading && !data && !error && !customInvalid ? (
        <Skeleton label={t("states.loading")} rows={6} variant="lines" />
      ) : null}

      {data && overview && range ? (
        <>
          <MetricGrid
            hasData={
              data.overview.items.length > 0 ||
              data.breakdown.items.length > 0
            }
            locale={locale}
            totals={overview}
          />
          {data.overview.items.length === 0 ? (
            <EmptyState
              body={t("states.emptyBody")}
              title={t("states.emptyTitle")}
            />
          ) : (
            <>
              <Panel
                className="grid min-w-0 gap-3 px-4 py-4"
                radius="md"
                variant="flat"
              >
                <SectionHeader
                  description={t("trend.description", {
                    dimension: dimensionName,
                  })}
                  level={3}
                  title={t("trend.title")}
                />
                <UsageTrend
                  dimension={dimension}
                  dimensionName={dimensionName}
                  from={range.from}
                  granularity={granularity}
                  groupLabel={(key) =>
                    dimensionLabel(key, dimension, {
                      deviceLabels,
                      t,
                      userLabels,
                      workspaceLabels,
                    })
                  }
                  items={data.breakdown.items}
                  to={range.to}
                />
              </Panel>

              <section className="grid min-w-0 gap-3">
                <SectionHeader
                  actions={
                    <span className="text-xs text-ink-muted">
                      {t("table.rows", { count: rows.length })}
                    </span>
                  }
                  title={t("table.title")}
                  description={t("table.description", {
                    dimension: dimensionName,
                  })}
                />
                {rows.length === 0 ? (
                  <EmptyState
                    body={t("table.emptyBody")}
                    title={t("table.emptyTitle")}
                  />
                ) : (
                  <BreakdownTable
                    dimension={dimension}
                    dimensionName={dimensionName}
                    deviceLabels={deviceLabels}
                    locale={locale}
                    rows={rows}
                    truncated={
                      data.breakdown.total > data.breakdown.items.length
                    }
                    workspaceLabels={workspaceLabels}
                    userLabels={userLabels}
                  />
                )}
              </section>
            </>
          )}
        </>
      ) : null}
    </PageSurface>
  );
}

function FilterField({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <div className="grid min-w-0 gap-1.5">
      <span className="text-2xs leading-none font-semibold text-ink-muted">
        {label}
      </span>
      {children}
    </div>
  );
}

function DateField({
  label,
  max,
  onChange,
  value,
}: {
  label: string;
  max: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <label className="grid min-w-36 gap-1.5">
      <span className="text-2xs leading-none font-semibold text-ink-muted">
        {label}
      </span>
      <TextInput
        max={max}
        onChange={(event) => onChange(event.currentTarget.value)}
        tone="boxed"
        type="date"
        value={value}
      />
    </label>
  );
}

function MetricGrid({
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
      : (formatTimeToFirstToken(totals.ttftP50Ms) ??
        t("states.noValue"));
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

function BreakdownTable({
  deviceLabels,
  dimension,
  dimensionName,
  locale,
  rows,
  truncated,
  userLabels,
  workspaceLabels,
}: {
  deviceLabels: ReadonlyMap<string, string>;
  dimension: UsageDimension;
  dimensionName: string;
  locale: string;
  rows: readonly UsageBreakdownRow[];
  truncated: boolean;
  userLabels: ReadonlyMap<string, string>;
  workspaceLabels: ReadonlyMap<string, string>;
}) {
  const { t } = useTranslation("usage");
  const label = (key: string) =>
    dimensionLabel(key, dimension, {
      deviceLabels,
      t,
      userLabels,
      workspaceLabels,
    });
  return (
    <div className="grid min-w-0 gap-2">
      <RecordsTable scrollLabel={t("table.scrollLabel")}>
        <caption className="sr-only">
          {t("table.description", { dimension: dimensionName })}
        </caption>
        <RecordsHead>
          <RecordsRow>
            <RecordsHeaderCell>{t("table.dimension")}</RecordsHeaderCell>
            <RecordsHeaderCell>{t("table.turns")}</RecordsHeaderCell>
            <RecordsHeaderCell>{t("table.requests")}</RecordsHeaderCell>
            <RecordsHeaderCell>{t("table.inputTokens")}</RecordsHeaderCell>
            <RecordsHeaderCell>{t("table.outputTokens")}</RecordsHeaderCell>
            <RecordsHeaderCell>{t("table.cost")}</RecordsHeaderCell>
            <RecordsHeaderCell>{t("table.medianSpeed")}</RecordsHeaderCell>
            <RecordsHeaderCell>{t("table.ttftP50")}</RecordsHeaderCell>
          </RecordsRow>
        </RecordsHead>
        <RecordsBody>
          {rows.map((row) => (
            <RecordsRow key={row.key}>
              <RecordsCell>
                <span className="font-medium text-ink">{label(row.key)}</span>
              </RecordsCell>
              <RecordsCell>{wholeNumber(row.turns, locale)}</RecordsCell>
              <RecordsCell>{wholeNumber(row.requests, locale)}</RecordsCell>
              <RecordsCell>{wholeNumber(row.inputTokens, locale)}</RecordsCell>
              <RecordsCell>{wholeNumber(row.outputTokens, locale)}</RecordsCell>
              <RecordsCell>{currency(row.costUsd, locale)}</RecordsCell>
              <RecordsCell>
                {row.medianTokensPerSecond === undefined
                  ? "—"
                  : decimalNumber(row.medianTokensPerSecond, locale, 1)}
              </RecordsCell>
              <RecordsCell>
                {row.ttftP50Ms === undefined
                  ? "—"
                  : (formatTimeToFirstToken(row.ttftP50Ms) ?? "—")}
              </RecordsCell>
            </RecordsRow>
          ))}
        </RecordsBody>
      </RecordsTable>
      {truncated ? (
        <p className="m-0 text-xs text-ink-muted">
          {t("table.truncated", { limit: 500 })}
        </p>
      ) : null}
    </div>
  );
}

function dimensionLabel(
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

function sourceLabel(
  source: string,
  t: TFunction<"usage">,
): string {
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

function sourceShare(
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

function compactNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    notation: "compact",
  }).format(value);
}

function wholeNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(
    value,
  );
}

function decimalNumber(
  value: number,
  locale: string,
  maximumFractionDigits: number,
): string {
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits,
    minimumFractionDigits: value < 10 ? Math.min(1, maximumFractionDigits) : 0,
  }).format(value);
}

function currency(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    currency: "USD",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(value);
}

function compactCurrency(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    currency: "USD",
    currencyDisplay: "narrowSymbol",
    maximumFractionDigits: 1,
    notation: "compact",
    style: "currency",
  }).format(value);
}
