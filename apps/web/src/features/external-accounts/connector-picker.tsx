import type {
  ConnectorDescriptor,
  DeviceConnectorsView,
  ExternalAccount,
} from "@bd777/foundry-protocol";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getExternalAccounts } from "../../api";
import { Badge } from "../../components/ui/badge";
import {
  SearchSelect,
  type SearchSelectOption,
} from "../../components/ui/search-select";
import type { ConnectorType } from "../../lib/connector-types";
import { connectorDescription, connectorName } from "./connector-text";

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

export interface ConnectorPickerProps {
  catalog: ConnectorDescriptor[];
  /** The page's last reading of the person's devices, when it has one. */
  devices?: DeviceConnectorsView;
  value: ConnectorType;
  onChange: (kind: ConnectorType) => void;
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
  onChange,
  value,
}: ConnectorPickerProps) {
  const { t } = useTranslation("externalAccounts");
  const [accounts, setAccounts] = useState<ExternalAccount[]>();

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

  return (
    <SearchSelect
      ariaLabel={t("page.picker.label")}
      className="max-w-[420px]"
      emptyText={t("page.picker.noMatch")}
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
      searchPlaceholder={t("page.picker.search")}
      value={value}
    />
  );
}
