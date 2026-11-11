import type {
  ConnectorDescriptor,
  ConnectorRestricted,
  ConnectorRestrictedDevice,
  DeviceConnectorsView,
  ExternalAccount,
} from "@bd777/foundry-protocol";
import { ArrowLeft, ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import type { TFunction } from "i18next";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getExternalAccounts } from "../../api";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { DividedList } from "../../components/ui/divided-list";
import { SectionHead, SectionPanel } from "../../components/ui/section-panel";
import {
  SearchSelect,
  type SearchSelectOption,
} from "../../components/ui/search-select";
import type { ConnectorType } from "../../lib/connector-types";
import { errorText } from "./account-format";
import {
  connectorDescription,
  connectorName,
  localized,
} from "./connector-text";

type PickerStatus =
  "connected" | "signedIn" | "lastSignedIn" | "needsSignIn" | "notSetUp";

const statusTone = {
  connected: "online",
  signedIn: "online",
  lastSignedIn: "slate",
  needsSignIn: "warn",
  notSetUp: "neutral",
} as const;

/** A reading this recent from a device still online counts as current (connectorStaleAfter). */
const currentForMs = 2 * 60_000;

/** A server-held connector's accounts, as the server keeps them. */
function serverHeldStatus(
  kind: string,
  accounts: ExternalAccount[] | undefined,
): PickerStatus | undefined {
  if (!accounts) return undefined;
  const own = accounts.filter((account) => account.provider === kind);
  if (own.some((a) => a.status === "ready" || a.status === "expiring"))
    return "connected";
  return own.length ? "needsSignIn" : "notSetUp";
}

/**
 * A device-held connector on the person's devices, as read there: signed
 * in only on a reading an online device just gave; an older one, or one
 * from a device now offline, is the last seen login, not a current one.
 */
function deviceHeldStatus(
  kind: string,
  view: DeviceConnectorsView | undefined,
  now = Date.now(),
): PickerStatus | undefined {
  if (!view) return undefined;
  const readings = view.devices.flatMap((device) =>
    device.states
      .filter((state) => state.kind === kind)
      .map((state) => ({ device, state })),
  );
  const states = readings.map((reading) => reading.state);
  if (
    readings.some(
      ({ device, state }) =>
        state.signedIn &&
        device.online &&
        now - Date.parse(state.checkedAt) < currentForMs,
    )
  )
    return "signedIn";
  if (states.some((state) => state.signedIn)) return "lastSignedIn";
  return states.some((state) => state.installed) ? "needsSignIn" : "notSetUp";
}

function restrictedDeviceMeets(
  connector: ConnectorDescriptor,
  device: ConnectorRestrictedDevice,
): boolean {
  const requirementsMet =
    !connector.requires?.length || device.requirementsCheck?.ok === true;
  const accessMet = !connector.access || device.accessCheck?.status === "ok";
  return requirementsMet && accessMet;
}

function restrictedSummary(
  t: TFunction<"externalAccounts">,
  connector: ConnectorDescriptor,
  devices: ConnectorRestrictedDevice[],
): string {
  if (devices.length === 0) return t("page.restricted.noDevices");
  const unmet = devices.filter(
    (device) => !restrictedDeviceMeets(connector, device),
  ).length;
  if (unmet === 0) return t("page.restricted.readyToRecheck");
  if (unmet === devices.length)
    return t("page.restricted.allDevicesNeedAccess", { count: unmet });
  return t("page.restricted.someDevicesNeedAccess", { count: unmet });
}

function RestrictedDeviceReasons({
  connector,
  device,
  onOpenConnector,
}: {
  connector: ConnectorDescriptor;
  device: ConnectorRestrictedDevice;
  onOpenConnector?: (kind: string) => void;
}) {
  const { t } = useTranslation("externalAccounts");
  const access = connector.access;
  const via = device.viaLabel ?? device.accessCheck?.via ?? "";
  const requirements = connector.requires ?? [];
  return (
    <li className="grid gap-1.5" key={`${connector.kind}:${device.deviceId}`}>
      <strong className="text-sm text-ink">{device.name}</strong>
      {requirements.map((requirement) => {
        const check = device.requirementsCheck;
        const failed =
          check?.ok === false &&
          (!check.requirement || check.requirement === requirement.label);
        return (
          <span
            className={
              failed ? "text-xs text-warn-text" : "text-xs text-ink-muted"
            }
            key={`${requirement.host}:${requirement.port}`}
          >
            {!check
              ? t("page.restricted.notChecked")
              : failed
                ? t("page.restricted.requirementFailed", {
                    label: requirement.label,
                    host: requirement.host,
                    port: requirement.port,
                  })
                : t("page.restricted.requirementMet", {
                    label: requirement.label,
                  })}
          </span>
        );
      })}
      {access ? (
        <span
          className={
            device.accessCheck?.status === "ok"
              ? "text-xs text-ink-muted"
              : "text-xs text-warn-text"
          }
        >
          {!device.accessCheck
            ? t("page.restricted.notChecked")
            : device.accessCheck.status === "ok"
              ? t(
                  device.accessCheck.identity
                    ? "page.restricted.accessMet"
                    : "page.restricted.accessMetAnonymous",
                  {
                    via,
                    account: device.accessCheck.identity,
                    repository: access.repository,
                  },
                )
              : device.accessCheck.status === "not_signed_in"
                ? t("page.restricted.notSignedIn", {
                    via,
                    repository: access.repository,
                  })
                : device.accessCheck.status === "no_access"
                  ? t(
                      device.accessCheck.identity
                        ? "page.restricted.noAccess"
                        : "page.restricted.noAccessAnonymous",
                      {
                        via,
                        account: device.accessCheck.identity,
                        repository: access.repository,
                      },
                    )
                  : t("page.restricted.accessFailed", {
                      via,
                      repository: access.repository,
                      detail: device.accessCheck.detail,
                    })}
        </span>
      ) : null}
      {access &&
      device.accessCheck?.status !== "ok" &&
      device.accessCheck &&
      onOpenConnector ? (
        <Button
          className="w-fit"
          onClick={() => onOpenConnector(access.via)}
          size="inline"
          variant="ghost"
        >
          {t("page.restricted.openConnector", { via })}
          <ChevronRight aria-hidden="true" size={13} />
        </Button>
      ) : null}
    </li>
  );
}

/** The full restricted-connector explanation, shown in the page body. */
export function RestrictedConnectorDetails({
  item,
  onBack,
  onOpenConnector,
  onRecheck,
}: {
  item: ConnectorRestricted;
  onBack: () => void;
  onOpenConnector: (kind: string) => void;
  /** Refreshes checks; throws when the refresh itself could not run. */
  onRecheck: () => Promise<void>;
}) {
  const { t } = useTranslation("externalAccounts");
  const [rechecking, setRechecking] = useState(false);
  const [recheckError, setRecheckError] = useState("");
  const connector = item.connector;
  const hint = connector.access?.hint
    ? localized(connector.access.hint, connector.access.hints)
    : connectorDescription(connector);

  async function recheck() {
    setRechecking(true);
    setRecheckError("");
    try {
      await onRecheck();
    } catch (cause) {
      setRecheckError(errorText(cause));
    } finally {
      setRechecking(false);
    }
  }

  return (
    <SectionPanel
      aria-busy={rechecking || undefined}
      aria-label={t("page.restricted.details", {
        connector: connectorName(connector),
      })}
    >
      <div className="flex min-w-0 items-start justify-between gap-3 max-[620px]:flex-wrap">
        <SectionHead description={hint} title={connectorName(connector)} />
        <Button onClick={onBack} size="sm" variant="ghost">
          <ArrowLeft aria-hidden="true" size={14} />
          {t("page.restricted.back")}
        </Button>
      </div>
      {item.devices.length ? (
        <DividedList density="cozy">
          {item.devices.map((device) => (
            <RestrictedDeviceReasons
              connector={connector}
              device={device}
              key={device.deviceId}
              onOpenConnector={onOpenConnector}
            />
          ))}
        </DividedList>
      ) : (
        <span className="text-sm text-ink-muted">
          {t("page.restricted.noDevices")}
        </span>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Button
          aria-busy={rechecking || undefined}
          disabled={rechecking}
          onClick={() => void recheck()}
          size="sm"
          variant="secondary"
        >
          {rechecking ? null : <RefreshCw aria-hidden="true" size={14} />}
          {rechecking
            ? t("page.restricted.rechecking")
            : t("page.restricted.recheck")}
        </Button>
        {recheckError ? (
          <span className="text-xs text-error-text">{recheckError}</span>
        ) : null}
      </div>
    </SectionPanel>
  );
}

export interface ConnectorPickerProps {
  catalog: ConnectorDescriptor[];
  restricted?: ConnectorRestricted[];
  /** The page's last reading of the person's devices, when it has one. */
  devices?: DeviceConnectorsView;
  value: ConnectorType;
  onChange: (kind: ConnectorType) => void;
  onRestrictedSelect?: (selection: ConnectorRestricted) => void;
}

/**
 * The Connectors page's connector choice: a searchable list grouped into
 * public connectors (built into Foundry) and private ones (from connector
 * extensions on the person's own devices, seen only by them), each with
 * its status from what the server keeps and what devices last reported.
 */
export function ConnectorPicker({
  catalog,
  devices,
  restricted = [],
  onChange,
  onRestrictedSelect,
  value,
}: ConnectorPickerProps) {
  const { t } = useTranslation("externalAccounts");
  const [accounts, setAccounts] = useState<ExternalAccount[]>();
  const [restrictedOpen, setRestrictedOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Status only: a failed read leaves the entries without one.
  useEffect(() => {
    let cancelled = false;
    getExternalAccounts()
      .then((view) => {
        if (!cancelled) setAccounts(view.accounts);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  function option(connector: ConnectorDescriptor): SearchSelectOption {
    const status =
      connector.holding === "server_held"
        ? serverHeldStatus(connector.kind, accounts)
        : deviceHeldStatus(connector.kind, devices);
    return {
      value: connector.kind,
      label: connectorName(connector),
      detail: connectorDescription(connector),
      keywords: [
        connector.kind,
        connector.label,
        ...Object.values(connector.labels ?? {}),
        connector.description ?? "",
        ...Object.values(connector.descriptions ?? {}),
        connector.tool.command,
        connector.extension?.name ?? "",
        connector.extension?.id ?? "",
      ].filter(Boolean),
      status: status ? (
        <Badge tone={statusTone[status]}>{t(`page.picker.${status}`)}</Badge>
      ) : undefined,
    };
  }

  const restrictedFooter = restricted.length ? (
    <div className="mt-1 border-t border-line pt-1">
      <Button
        aria-expanded={restrictedOpen}
        className="w-full justify-start"
        onClick={() => setRestrictedOpen((open) => !open)}
        size="sm"
        variant="ghost"
      >
        {restrictedOpen ? (
          <ChevronDown aria-hidden="true" size={14} />
        ) : (
          <ChevronRight aria-hidden="true" size={14} />
        )}
        {t("page.restricted.title", { count: restricted.length })}
      </Button>
      {restrictedOpen ? (
        <div className="grid gap-0.5 px-1 pb-1">
          {restricted.map((item) => (
            <Button
              className="w-full min-w-0 justify-between gap-2 px-2"
              key={item.connector.kind}
              onClick={() => {
                setPickerOpen(false);
                onRestrictedSelect?.(item);
              }}
              size="sm"
              variant="ghost"
            >
              <span className="min-w-0 truncate">
                {connectorName(item.connector)}
              </span>
              <small className="min-w-0 truncate text-ink-faint">
                {restrictedSummary(t, item.connector, item.devices)}
              </small>
              <ChevronRight aria-hidden="true" size={13} />
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  ) : undefined;

  return (
    <SearchSelect
      ariaLabel={t("page.picker.label")}
      className="max-w-[420px]"
      emptyText={t("page.picker.noMatch")}
      footer={restrictedFooter}
      groups={[
        {
          key: "public",
          heading: t("page.picker.public"),
          description: t("page.picker.publicSource"),
          options: catalog.filter((entry) => !entry.extension).map(option),
        },
        {
          key: "private",
          heading: t("page.picker.private"),
          description: t("page.picker.privateSource"),
          options: catalog.filter((entry) => entry.extension).map(option),
        },
      ]}
      onChange={onChange}
      onOpenChange={setPickerOpen}
      open={pickerOpen}
      searchPlaceholder={t("page.picker.search")}
      value={value}
    />
  );
}
