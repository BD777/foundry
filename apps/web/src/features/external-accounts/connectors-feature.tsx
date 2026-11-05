import type { ToastTone } from "../../components/ui/toast";
import type {
  ConnectorDescriptor,
  DeviceConnectorDevice,
  DeviceConnectorsView,
} from "@bd777/foundry-protocol";
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getConnectorCatalog, getDeviceConnectors } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/loading";
import { PageSurface } from "../../components/ui/page-surface";
import type { ConnectorType } from "../../lib/connector-types";
import { errorText } from "./account-format";
import { AddConnectorDialog } from "./add-connector-dialog";
import { CloudflareConnector } from "./cloudflare-connector";
import { connectorName } from "./connector-text";
import { ConnectorPicker } from "./connector-picker";
import { CredentialHolding } from "./credential-holding";
import { DeviceHeldConnector } from "./device-held-connector";
import { ExtensionInstallDialog } from "./extension-install-dialog";
import { FeishuConnector } from "./feishu-connector";
import { PageHeader } from "../../components/ui/page-header";

export interface ConnectorsFeatureProps {
  currentUserId: string;
  isAdmin: boolean;
  onNotice: (message: string, tone?: ToastTone) => void;
  onTabChange: (tab: ConnectorType) => void;
  tab: ConnectorType;
}

/**
 * The Connectors page: external services a person's sessions use under the
 * person's own identity. A searchable picker chooses among the connectors
 * the catalog lists, public ones Foundry has built in and private ones that
 * connector extensions on the person's devices provide. Under it, where the
 * chosen one keeps its credentials, then its accounts (server-held) or
 * devices (device-held).
 */
export function ConnectorsFeature({
  onTabChange,
  tab,
  ...props
}: ConnectorsFeatureProps) {
  const { t } = useTranslation(["externalAccounts", "common"]);
  const [catalog, setCatalog] = useState<ConnectorDescriptor[]>();
  const [loadError, setLoadError] = useState("");
  const [adding, setAdding] = useState(false);
  // Installing an extension from a repository: the person's devices.
  const [installDevices, setInstallDevices] =
    useState<DeviceConnectorDevice[]>();
  // The connector a just-installed extension provides, shown once listed.
  const [awaited, setAwaited] = useState<{ kind: string; until: number }>();
  // The last reading of the person's devices, for every device-held
  // connector: the picker's statuses, and what a device-held tab draws
  // first. It lives while the page is open, never across sign-ins.
  const [devices, setDevices] = useState<DeviceConnectorsView>();

  async function load() {
    try {
      setCatalog((await getConnectorCatalog()).connectors);
      setLoadError("");
    } catch (cause) {
      setLoadError(errorText(cause));
    }
  }
  useEffect(() => {
    void load();
    // The stored readings answer at once; a failure leaves no statuses.
    getDeviceConnectors(false)
      .then((view) => setDevices((current) => current ?? view))
      .catch(() => undefined);
  }, []);

  // The device reports a new extension's connectors at once; read the
  // catalog until its tab is there, then open it.
  useEffect(() => {
    if (!awaited) return;
    if (catalog?.some((entry) => entry.kind === awaited.kind)) {
      onTabChange(awaited.kind);
      setAwaited(undefined);
      return;
    }
    if (Date.now() > awaited.until) {
      setAwaited(undefined);
      return;
    }
    const timer = setTimeout(() => void load(), 1_500);
    return () => clearTimeout(timer);
  }, [awaited, catalog]);

  // A tab whose connector left (its extension removed) gives way to the first.
  useEffect(() => {
    if (
      catalog?.length &&
      !awaited &&
      !catalog.some((entry) => entry.kind === tab)
    )
      onTabChange(catalog[0]!.kind);
  }, [catalog, tab, awaited]);

  async function installFromRepository() {
    setAdding(false);
    try {
      setInstallDevices((await getDeviceConnectors(false)).devices);
    } catch (cause) {
      props.onNotice(t("notices.failed", { error: errorText(cause) }), "error");
    }
  }

  const connector =
    catalog?.find((entry) => entry.kind === tab) ?? catalog?.[0];
  return (
    <PageSurface variant="connectors">
      <PageHeader
        title={t("page.title")}
        description={t("page.intro")}
        actions={
          <Button onClick={() => setAdding(true)} size="sm" variant="ghost">
            <Plus aria-hidden="true" size={14} />
            {t("addConnector.open")}
          </Button>
        }
      />
      {loadError ? (
        <Alert
          title={t("page.catalogFailed", { error: loadError })}
          tone="error"
        >
          <Button onClick={() => void load()} size="sm">
            {t("common:actions.retry")}
          </Button>
        </Alert>
      ) : !catalog || !connector ? (
        <Skeleton label={t("page.catalogLoading")} rows={2} variant="rows" />
      ) : (
        <>
          <ConnectorPicker
            catalog={catalog}
            devices={devices}
            onChange={onTabChange}
            value={connector.kind}
          />
          <CredentialHolding
            holding={connector.holding}
            name={connectorName(connector)}
            signOutLocal={connector.signIn?.signOut === false}
          />
          {connector.holding === "device_held" ? (
            <DeviceHeldConnector
              kind={connector.kind}
              key={connector.kind}
              lastView={devices}
              onCatalogChanged={() => void load()}
              onView={setDevices}
              onNotice={props.onNotice}
            />
          ) : connector.kind === "feishu" ? (
            <FeishuConnector {...props} />
          ) : connector.kind === "cloudflare" ? (
            <CloudflareConnector
              currentUserId={props.currentUserId}
              onNotice={props.onNotice}
            />
          ) : null}
        </>
      )}
      <AddConnectorDialog
        catalog={catalog ?? []}
        onClose={() => setAdding(false)}
        onInstallFromRepository={() => void installFromRepository()}
        open={adding}
      />
      <ExtensionInstallDialog
        devices={installDevices ?? []}
        key={installDevices ? "open" : "closed"}
        onClose={() => setInstallDevices(undefined)}
        onInstalled={(deviceId, reply) => {
          const device = installDevices?.find(
            (entry) => entry.deviceId === deviceId,
          );
          setInstallDevices(undefined);
          props.onNotice(
            t(
              reply.action === "unchanged"
                ? "deviceHeld.extensionUnchanged"
                : reply.action === "updated"
                  ? "deviceHeld.extensionUpdated"
                  : "deviceHeld.extensionInstalled",
              { extension: reply.extension?.name, device: device?.name },
            ),
          );
          const kind = reply.extension?.connectors[0];
          if (kind) setAwaited({ kind, until: Date.now() + 15_000 });
        }}
        target={installDevices ? {} : undefined}
      />
    </PageSurface>
  );
}
