import type { UsageStatsResult } from "@bd777/foundry-protocol";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { getUsageStats, listUsers } from "../../api";
import type { AccountUser } from "../../api-types";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { Skeleton } from "../../components/ui/loading";
import { PageHeader, SectionHeader } from "../../components/ui/page-header";
import { PageSurface } from "../../components/ui/page-surface";
import { Panel } from "../../components/ui/panel";
import { serverErrorText } from "../../lib/errors";
import { UsageFilters } from "./usage-filters";
import { dimensionLabel } from "./usage-format";
import { UsageMetricGrid } from "./usage-metrics";
import {
  addLocalDays,
  aggregateUsage,
  dateInputValue,
  groupUsage,
  hourlyUsageAvailable,
  type UsageDimension,
  type UsageGranularity,
  type UsageRangePreset,
  usageRange,
} from "./usage-model";
import { UsageBreakdownTable } from "./usage-table";
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

export function UsageFeature({
  currentUser,
  devices,
  isAdmin,
  workspaces,
}: UsageFeatureProps) {
  const { t, i18n } = useTranslation(["usage", "common"]);
  const today = dateInputValue(new Date());
  const [rangePreset, setRangePreset] = useState<UsageRangePreset>("sevenDays");
  const [customFrom, setCustomFrom] = useState(() =>
    dateInputValue(addLocalDays(new Date(), -6)),
  );
  const [customTo, setCustomTo] = useState(today);
  const [granularity, setGranularity] = useState<UsageGranularity>("day");
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
    () =>
      new Map(workspaces.map((workspace) => [workspace.id, workspace.name])),
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
        if (!(cause instanceof DOMException && cause.name === "AbortError")) {
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

  function chooseRange(nextRange: UsageRangePreset): void {
    setRangePreset(nextRange);
    if (nextRange === "today") setGranularity("hour");
    else if (nextRange !== "custom") setGranularity("day");
  }

  return (
    <PageSurface aria-busy={loading} variant="usage">
      <PageHeader title={t("page.title")} description={t("page.intro")} />

      <UsageFilters
        customFrom={customFrom}
        customInvalid={customInvalid}
        customTo={customTo}
        dimension={dimension}
        granularity={granularity}
        hasData={Boolean(data)}
        hourlyAvailable={hourlyAvailable}
        isAdmin={isAdmin}
        loading={loading}
        onCustomFromChange={setCustomFrom}
        onCustomToChange={setCustomTo}
        onDimensionChange={setDimension}
        onGranularityChange={setGranularity}
        onRangeChange={chooseRange}
        onUserChange={setSelectedUserId}
        rangePreset={rangePreset}
        selectedUserId={selectedUserId}
        today={today}
        users={users}
        usersLoading={usersLoading}
      />

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
        <Alert
          size="compact"
          title={t("filters.customInvalid")}
          tone="warning"
        />
      ) : null}
      {loading && !data && !error ? (
        <Skeleton label={t("states.loading")} rows={6} variant="lines" />
      ) : null}
      {!loading && !data && !error && !customInvalid ? (
        <Skeleton label={t("states.loading")} rows={6} variant="lines" />
      ) : null}

      {data && overview && range ? (
        <>
          <UsageMetricGrid
            hasData={
              data.overview.items.length > 0 || data.breakdown.items.length > 0
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
                  <UsageBreakdownTable
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
