import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight } from "lucide-react";
import {
  getPersonalAgentConnectors,
  setPersonalAgentConnectors,
  type PersonalAgentConnector,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { FieldHint } from "../../components/ui/field";
import { LoadingState, Spinner } from "../../components/ui/loading";
import { Switch } from "../../components/ui/switch";
import { ToastFeedback } from "../../components/ui/toast";
import { serverErrorText } from "../../lib/errors";
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

/** Server-held accounts first, then one group per device. */
function connectorGroups(
  connectors: PersonalAgentConnector[],
): ConnectorGroup[] {
  const byLabel = (a: PersonalAgentConnector, b: PersonalAgentConnector) =>
    a.label.localeCompare(b.label);
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

/** Which connector accounts the assistant may use. */
export function ConnectorsSection() {
  const { t } = useTranslation("personalAgent");
  const [connectors, setConnectors] = useState<PersonalAgentConnector[]>();
  const [loadError, setLoadError] = useState("");
  const [readVersion, setReadVersion] = useState(0);
  const [savingId, setSavingId] = useState<string>();
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    let active = true;
    setLoadError("");
    getPersonalAgentConnectors().then(
      (view) => {
        if (!active) return;
        setConnectors(view.connectors);
      },
      (reason: unknown) => {
        if (!active) return;
        setConnectors(undefined);
        setLoadError(serverErrorText(reason));
      },
    );
    return () => {
      active = false;
    };
  }, [readVersion]);

  async function toggle(
    account: PersonalAgentConnector,
    enabled: boolean,
  ): Promise<void> {
    if (savingId || !connectors) return;
    const previous = connectors;
    const next = connectors.map((connector) =>
      connector.id === account.id ? { ...connector, enabled } : connector,
    );
    setConnectors(next);
    setSavingId(account.id);
    setSaveError("");
    try {
      const answer = await setPersonalAgentConnectors(
        next
          .filter((connector) => !connector.enabled)
          .map((connector) => connector.id),
      );
      setConnectors(answer.connectors);
    } catch (reason) {
      setConnectors(previous);
      setSaveError(serverErrorText(reason));
    } finally {
      setSavingId(undefined);
    }
  }

  const groups = connectors ? connectorGroups(connectors) : [];
  return (
    <>
      <FieldHint className="mt-0">{t("settings.connectors.intro")}</FieldHint>
      {loadError ? (
        <Alert
          actions={
            <Button
              onClick={() => setReadVersion((value) => value + 1)}
              size="sm"
            >
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
                return (
                  <div
                    className="flex min-w-0 items-center gap-2.5 py-2.5 first:pt-0 last:pb-0"
                    key={account.id}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="m-0 text-sm font-medium wrap-anywhere text-ink">
                        {account.label}
                      </p>
                      <p className="m-0 mt-0.5 text-xs leading-[1.45] wrap-anywhere text-ink-muted">
                        {isServerHeld(account)
                          ? t("settings.connectors.serverDetail", {
                              kind: account.kind,
                              status,
                            })
                          : t("settings.connectors.deviceDetail", {
                              kind: account.kind,
                              device:
                                account.deviceName ||
                                t("settings.connectors.unknownComputer"),
                            })}
                      </p>
                    </div>
                    <span className="flex size-3.5 flex-none items-center justify-center text-ink-muted">
                      {savingId === account.id ? <Spinner size={12} /> : null}
                    </span>
                    <Switch
                      aria-busy={savingId === account.id}
                      aria-label={t("settings.connectors.switchLabel", {
                        label: account.label,
                      })}
                      checked={account.enabled}
                      disabled={Boolean(savingId)}
                      onCheckedChange={(enabled) =>
                        void toggle(account, enabled)
                      }
                    />
                  </div>
                );
              })}
            </div>
          </SettingsGroup>
        ))
      )}
      {saveError ? (
        <ToastFeedback tone="error" title={t("settings.connectors.saveFailed")}>
          {saveError}
        </ToastFeedback>
      ) : null}
    </>
  );
}
