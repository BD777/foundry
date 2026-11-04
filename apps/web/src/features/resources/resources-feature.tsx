import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, OctagonX } from "lucide-react";
import { resourceTypeIds } from "@bd777/foundry-protocol";
import { stopDeviceResources } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { CheckLabel } from "../../components/ui/check-label";
import { DividedList } from "../../components/ui/divided-list";
import { Checkbox } from "../../components/ui/field";
import { HelpHint } from "../../components/ui/help-hint";
import { PageSurface } from "../../components/ui/page-surface";
import { Panel } from "../../components/ui/panel";
import { SelectMenu } from "../../components/ui/select-menu";
import { navigateToDeviceResources } from "../../lib/in-app-navigation";
import { readPageQuery, replacePageQuery } from "../../lib/page-query";
import { relativeWhen } from "../../lib/time-format";
import { useResourceInventory } from "../../lib/resource-inventory";
import {
  detectionProblems,
  groupResources,
  resourceSources,
  resourceTypeFrom,
  resourceTypeLabel,
  type ResourceDeviceGroup,
  type ResourceFilter,
} from "./resource-groups";
import { useResourceAction } from "./resource-action";
import { ResourceConfirmDialog } from "./resource-confirm-dialog";
import { ResourceRow } from "./resource-row";
import { Skeleton } from "../../components/ui/loading";
import { PageHeader } from "../../components/ui/page-header";

/**
 * The Resources page: every resource instance the devices report, by type
 * and then device. `?type=` and `?device=` filter it; they are read when the
 * page opens and written from its state after that. On the devices the
 * person owns (`ownedDeviceIds`) they can release what sessions hold, stop
 * every lease on a device, set up its backends and read its activity.
 */
export function ResourcesFeature({
  ownedDeviceIds = [],
}: {
  ownedDeviceIds?: readonly string[];
}) {
  const { t } = useTranslation("resources");
  const [filter, setFilter] = useState<ResourceFilter>(() => ({
    type: resourceTypeFrom(readPageQuery("type")),
    device: readPageQuery("device"),
  }));
  const [includeGone, setIncludeGone] = useState(false);
  const inventory = useResourceInventory({ includeGone });
  const { list } = inventory;

  useEffect(() => {
    replacePageQuery({ type: filter.type, device: filter.device });
  }, [filter.type, filter.device]);
  // The filter belongs to this page: leaving it takes it off the URL.
  useEffect(() => () => replacePageQuery({ type: "", device: "" }), []);

  const groups = useMemo(
    () => (list ? groupResources(list, filter) : []),
    [list, filter],
  );
  const problems = useMemo(
    () => (list ? detectionProblems(list, filter) : []),
    [list, filter],
  );
  const sources = useMemo(() => (list ? resourceSources(list) : []), [list]);
  const ownedKey = ownedDeviceIds.join(",");
  const owned = useMemo(() => new Set(ownedKey.split(",")), [ownedKey]);
  const filtered = Boolean(filter.type || filter.device);

  return (
    <PageSurface variant="resources">
      <PageHeader
        title={t("page.title")}
        description={t("page.intro")}
        help={<HelpHint label={t("page.helpLabel")}>{t("page.help")}</HelpHint>}
      />
      <div
        aria-label={t("filters.label")}
        className="fdy-res-filters flex flex-wrap items-center gap-x-3 gap-y-2"
        role="group"
      >
        <SelectMenu
          ariaLabel={t("filters.type")}
          className="fdy-res-filter min-w-45"
          onChange={(type) =>
            setFilter((current) => ({
              ...current,
              type: resourceTypeFrom(type),
            }))
          }
          options={[
            { value: "", label: t("filters.allTypes") },
            ...resourceTypeIds.map((type) => ({
              value: type,
              label: resourceTypeLabel(type),
            })),
          ]}
          value={filter.type}
        />
        <SelectMenu
          ariaLabel={t("filters.device")}
          className="fdy-res-filter min-w-45"
          onChange={(device) =>
            setFilter((current) => ({ ...current, device }))
          }
          options={[
            { value: "", label: t("filters.allDevices") },
            ...sources.map((source) => ({
              value: source.id,
              label: source.label,
            })),
          ]}
          value={filter.device}
        />
        <CheckLabel className="fdy-res-check items-center [&>input]:mt-0">
          <Checkbox
            checked={includeGone}
            onChange={(event) => setIncludeGone(event.target.checked)}
          />
          <span>{t("filters.showGone")}</span>
        </CheckLabel>
      </div>
      {inventory.error ? (
        <Alert
          tone="error"
          title={t("loadFailed")}
          actions={
            <Button size="sm" variant="secondary" onClick={inventory.reload}>
              {t("retry")}
            </Button>
          }
        >
          {inventory.error}
        </Alert>
      ) : null}
      {problems.length ? (
        <Alert
          className="fdy-res-problems"
          tone="warning"
          title={t("problems.title")}
        >
          <ul className="grid gap-1 pl-4.5 wrap-anywhere">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      {!list && inventory.loading ? (
        <Skeleton label={t("loading")} rows={4} variant="rows" />
      ) : null}
      {list && groups.length === 0 ? (
        filtered ? (
          <EmptyState
            title={t("emptyFilteredTitle")}
            body={
              <>
                {t("emptyFilteredBody")}{" "}
                <Button
                  size="inline"
                  variant="link"
                  onClick={() => setFilter({ type: "", device: "" })}
                >
                  {t("filters.clear")}
                </Button>
              </>
            }
          />
        ) : (
          <EmptyState title={t("emptyTitle")} body={t("emptyBody")} />
        )
      ) : null}
      {groups.map((group) => (
        <Panel
          aria-labelledby={`fdy-res-type-${group.type}`}
          className="fdy-res-type grid min-w-0 gap-1 px-4.5 py-4"
          key={group.type}
          role="region"
        >
          <h2
            className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-md font-bold text-ink"
            id={`fdy-res-type-${group.type}`}
          >
            {resourceTypeLabel(group.type)}
            <span className="text-xs font-normal text-ink-muted">
              {t("count", {
                count: group.devices.reduce(
                  (sum, device) => sum + device.instances.length,
                  0,
                ),
              })}
            </span>
          </h2>
          {group.devices.map((device) => (
            <DeviceGroup
              key={device.source.id}
              group={device}
              manageable={
                device.source.kind === "device" && owned.has(device.source.id)
              }
              typeLabel={resourceTypeLabel(group.type)}
              onChanged={inventory.reload}
            />
          ))}
        </Panel>
      ))}
    </PageSurface>
  );
}

function DeviceGroup({
  group,
  manageable,
  typeLabel,
  onChanged,
}: {
  group: ResourceDeviceGroup;
  manageable: boolean;
  typeLabel: string;
  onChanged: () => void;
}) {
  const { t } = useTranslation("resources");
  const { source, status } = group;
  const held = group.instances.some((instance) => instance.holder);
  const stop = useResourceAction<"stop">();
  const [confirming, setConfirming] = useState(false);
  const stopAll = () =>
    void stop.run("stop", async () => {
      const { released } = await stopDeviceResources(source.id);
      onChanged();
      return released
        ? t("stop.done", { count: released, device: source.label })
        : t("stop.none", { device: source.label });
    });
  const report = status?.lastReportAt
    ? t("source.lastReport", { when: relativeWhen(status.lastReportAt) })
    : t("source.noReport");
  return (
    <section
      className="fdy-res-device grid min-w-0 pt-2 [section+&]:border-t [section+&]:border-line"
      data-source={source.id}
    >
      <header className="fdy-res-device-head flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        {source.kind === "device" ? (
          <Button
            aria-label={t("source.open", { device: source.label })}
            size="sm"
            variant="ghost"
            onClick={() => navigateToDeviceResources(source.id)}
          >
            {source.label}
            <ArrowRight aria-hidden="true" size={14} />
          </Button>
        ) : (
          <strong className="text-sm text-ink">{source.label}</strong>
        )}
        <span className="fdy-res-device-status min-w-0 flex-auto text-xs text-ink-muted">
          {status
            ? `${t(status.online ? "source.online" : "source.offline")} · ${report}`
            : null}
        </span>
        {manageable && (held || stop.running) ? (
          <Button
            aria-busy={Boolean(stop.running)}
            disabled={Boolean(stop.running)}
            size="sm"
            variant="danger"
            onClick={() => setConfirming(true)}
          >
            <OctagonX aria-hidden="true" size={14} />
            {stop.running
              ? t("stop.stopping")
              : t("stop.action", { device: source.label })}
          </Button>
        ) : null}
      </header>
      {confirming ? (
        <ResourceConfirmDialog
          confirmLabel={t("stop.confirm")}
          description={t("stop.description")}
          destructive
          items={[
            t("stop.items.fails"),
            t("stop.items.reset", { device: source.label }),
            t("stop.items.waiting"),
          ]}
          title={t("stop.title", { device: source.label })}
          onClose={() => setConfirming(false)}
          onConfirm={stopAll}
        />
      ) : null}
      <DividedList
        aria-label={t("listLabel", { type: typeLabel, device: source.label })}
        className="fdy-res-list"
        density="cozy"
      >
        {group.instances.map((instance) => (
          <ResourceRow
            instance={instance}
            key={instance.id}
            manageable={manageable}
            remoteCommands={status?.allowRemoteCommands ?? false}
            onChanged={onChanged}
          />
        ))}
      </DividedList>
    </section>
  );
}
