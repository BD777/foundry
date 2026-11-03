import type { ToastTone } from "../../components/ui/toast";
import type { ConnectorDescriptor } from "@bd777/foundry-protocol";
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getConnectorCatalog } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/loading";
import { PageSurface } from "../../components/ui/page-surface";
import { SegmentedControl } from "../../components/ui/segmented-control";
import type { ConnectorType } from "../../lib/connector-types";
import { errorText } from "./account-format";
import { AddConnectorDialog } from "./add-connector-dialog";
import { CloudflareConnector } from "./cloudflare-connector";
import { connectorName } from "./connector-text";
import { CredentialHolding } from "./credential-holding";
import { DeviceHeldConnector } from "./device-held-connector";
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
 * person's own identity, one tab per connector the catalog lists, those
 * Foundry has built in and those connector extensions on the person's
 * devices provide. Under the tabs, where the open one keeps its
 * credentials, then its accounts (server-held) or devices (device-held).
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
  }, []);

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
          <SegmentedControl
            aria-label={t("page.tabs")}
            onValueChange={onTabChange}
            options={catalog.map((entry) => ({
              value: entry.kind,
              label: connectorName(entry),
            }))}
            tone="navigation"
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
        open={adding}
      />
    </PageSurface>
  );
}
