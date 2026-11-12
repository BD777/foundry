import { useTranslation } from "react-i18next";
import { ArrowRight } from "lucide-react";
import type {
  ConnectorAccessLevel,
  ConnectorAccountPermission,
  PersonalAgentConnector,
} from "@bd777/foundry-protocol";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { FieldHint } from "../../components/ui/field";
import { LoadingState } from "../../components/ui/loading";
import { SegmentedControl } from "../../components/ui/segmented-control";
import {
  accountPlace,
  customLabel,
  personName,
} from "../../lib/account-display";
import { navigateToConnectors } from "../../lib/in-app-navigation";
import { defaultConnectorType } from "../../lib/connector-types";
import { SettingsGroup } from "./settings-field";

interface ConnectorGroup {
  key: string;
  deviceName?: string;
  connectors: PersonalAgentConnector[];
}

const isServerHeld = (connector: PersonalAgentConnector) =>
  connector.holding === "server_held";

/** The complete override list sent by the settings save line. */
export function connectorLevels(
  connectors: readonly PersonalAgentConnector[],
): ConnectorAccountPermission[] {
  return connectors.map((connector) => ({
    accountId: connector.id,
    level: connector.level,
  }));
}

/** Server-held accounts first, then one group per device. */
function connectorGroups(
  connectors: PersonalAgentConnector[],
): ConnectorGroup[] {
  const byLabel = (a: PersonalAgentConnector, b: PersonalAgentConnector) =>
    `${personName(a)} ${accountPlace(a)}`.localeCompare(
      `${personName(b)} ${accountPlace(b)}`,
    );
  const server = connectors.filter(isServerHeld).sort(byLabel);
  const devices = new Map<
    string,
    { deviceName: string; connectors: PersonalAgentConnector[] }
  >();
  for (const connector of connectors.filter(
    (account) => !isServerHeld(account),
  )) {
    const key = connector.deviceId ?? connector.deviceName ?? connector.id;
    const group = devices.get(key) ?? {
      deviceName: connector.deviceName ?? "",
      connectors: [],
    };
    group.connectors.push(connector);
    devices.set(key, group);
  }
  return [
    ...(server.length ? [{ key: "server", connectors: server }] : []),
    ...[...devices.entries()]
      .sort(([, a], [, b]) => a.deviceName.localeCompare(b.deviceName))
      .map(([key, group]) => ({
        key,
        deviceName: group.deviceName,
        connectors: group.connectors.sort(byLabel),
      })),
  ];
}

const connectorStatuses = [
  "ready",
  "expiring",
  "needs_reauth",
  "revoked",
  "expired",
  "signed_out",
  "not_installed",
  "unavailable",
  "error",
] as const;

type ConnectorStatus = (typeof connectorStatuses)[number];

const isConnectorStatus = (status: string): status is ConnectorStatus =>
  (connectorStatuses as readonly string[]).includes(status);

const connectorLevelValues: ConnectorAccessLevel[] = ["off", "read", "write"];

/** Which connector accounts the assistant may use. */
export function ConnectorsSection({
  connectors,
  disabled = false,
  loadError,
  newAssistant = false,
  onChange,
  onRetry,
}: {
  connectors?: PersonalAgentConnector[];
  disabled?: boolean;
  loadError: string;
  newAssistant?: boolean;
  onChange: (accountId: string, level: ConnectorAccessLevel) => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation("personalAgent");

  const groups = connectors ? connectorGroups(connectors) : [];
  return (
    <>
      <FieldHint className="mt-0">{t("settings.connectors.intro")}</FieldHint>
      {newAssistant ? (
        <FieldHint className="mt-0">
          {t("settings.connectors.newAssistantHint")}
        </FieldHint>
      ) : null}
      {loadError ? (
        <Alert
          actions={
            <Button onClick={onRetry} size="sm">
              {t("settings.connectors.retry")}
            </Button>
          }
          title={t("settings.connectors.loadFailed")}
          tone="error"
        >
          {loadError}
        </Alert>
      ) : connectors === undefined ? (
        <LoadingState label={t("settings.connectors.loading")} layout="block" />
      ) : connectors.length === 0 ? (
        <EmptyState
          body={
            <>
              {t("settings.connectors.emptyBody")}{" "}
              <Button
                onClick={() => navigateToConnectors(defaultConnectorType)}
                size="inline"
                variant="link"
              >
                {t("settings.connectors.openConnectors")}
                <ArrowRight aria-hidden="true" size={13} />
              </Button>
            </>
          }
          title={t("settings.connectors.emptyTitle")}
        />
      ) : (
        groups.map((group) => (
          <SettingsGroup
            key={group.key}
            title={
              group.key === "server"
                ? t("settings.connectors.serverGroup")
                : group.deviceName || t("settings.connectors.unknownComputer")
            }
          >
            <div className="divide-y divide-line">
              {group.connectors.map((account) => {
                const status =
                  account.status && isConnectorStatus(account.status)
                    ? t(`settings.connectors.status.${account.status}`)
                    : t("settings.connectors.unknownStatus");
                const unsupportedDeviceRead =
                  account.holding === "device_held" && account.level === "read";
                const name = isServerHeld(account)
                  ? personName(account)
                  : account.label;
                const accessibleName = [name, accountPlace(account)]
                  .filter(Boolean)
                  .join(" · ");
                const serverPlace = [
                  customLabel(account),
                  accountPlace(account),
                ]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <div
                    className="grid min-w-0 gap-2 py-3 first:pt-0 last:pb-0 sm:flex sm:items-center sm:gap-3"
                    key={account.id}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="m-0 text-sm font-medium wrap-anywhere text-ink">
                        {name}
                      </p>
                      <p className="m-0 mt-0.5 text-xs leading-[1.45] wrap-anywhere text-ink-muted">
                        {isServerHeld(account)
                          ? [
                              serverPlace,
                              t("settings.connectors.serverDetail", {
                                kind: account.kind,
                                status,
                              }),
                            ]
                              .filter(Boolean)
                              .join(" · ")
                          : [
                              account.identity,
                              account.sites?.join(", "),
                              t("settings.connectors.deviceDetail", {
                                kind: account.kind,
                                device:
                                  account.deviceName ||
                                  t("settings.connectors.unknownComputer"),
                              }),
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                      </p>
                    </div>
                    <div className="grid min-w-0 gap-1 sm:ml-auto sm:max-w-sm sm:justify-items-end">
                      <SegmentedControl<ConnectorAccessLevel>
                        aria-label={t("settings.connectors.switchLabel", {
                          label: accessibleName,
                        })}
                        onValueChange={(level) => onChange(account.id, level)}
                        options={connectorLevelValues.map((value) => ({
                          disabled,
                          label: t(`settings.connectors.levels.${value}`),
                          value,
                        }))}
                        size="sm"
                        value={account.level}
                      />
                      {unsupportedDeviceRead ? (
                        <FieldHint
                          className="max-w-sm sm:text-right"
                          tone="warning"
                        >
                          {t("settings.connectors.deviceReadHint")}
                        </FieldHint>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </SettingsGroup>
        ))
      )}
    </>
  );
}
