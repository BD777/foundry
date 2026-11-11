import type { ToastTone } from "../../components/ui/toast";
import { AppStoreConnectConnector } from "./appstoreconnect-connector";
import { CloudflareConnector } from "./cloudflare-connector";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ConnectorDescriptor,
  ExternalAccount,
  WorkspaceExternalAccounts,
} from "@bd777/foundry-protocol";
import {
  getConnectorCatalog,
  getWorkspaceExternalAccounts,
  setWorkspaceExternalAccounts,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { navigateToConnectors } from "../../lib/in-app-navigation";
import { accountName, errorText } from "./account-format";
import { WorkspaceAccountAuthorization } from "./workspace-account-authorization";
import { WorkspaceDeviceConnectors } from "./workspace-device-connectors";
import { WorkspaceServerHeldSection } from "./workspace-server-held-section";
import { Skeleton } from "../../components/ui/loading";
import { MutedText } from "../../components/ui/text";

export interface WorkspaceConnectorsFeatureProps {
  workspaceId: string;
  currentUserId: string;
  /** Why the caller cannot change bindings (below Maintainer); still shown. */
  readOnlyReason?: string;
  onNotice: (message: string, tone?: ToastTone) => void;
}

/**
 * A workspace's Connectors tab: per connector type, which of the caller's
 * accounts (server-held) or devices' sign-ins (device-held) its sessions
 * may use, and what other members bound. Read on open and after each change.
 */
export function WorkspaceConnectorsFeature(
  props: WorkspaceConnectorsFeatureProps,
) {
  return <WorkspaceConnectorsContent key={props.workspaceId} {...props} />;
}

function WorkspaceConnectorsContent({
  workspaceId,
  currentUserId,
  readOnlyReason,
  onNotice,
}: WorkspaceConnectorsFeatureProps) {
  const { t } = useTranslation("externalAccounts");
  const [view, setView] = useState<WorkspaceExternalAccounts>();
  const [catalog, setCatalog] = useState<ConnectorDescriptor[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [authorizing, setAuthorizing] = useState<{
    account?: ExternalAccount;
  }>();
  const [bindingRetry, setBindingRetry] = useState<ExternalAccount>();
  const [bindingError, setBindingError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setView(undefined);
    setError("");
    getWorkspaceExternalAccounts(workspaceId)
      .then((next) => !cancelled && setView(next))
      .catch((cause) => !cancelled && setError(errorText(cause)));
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  useEffect(() => {
    let cancelled = false;
    getConnectorCatalog()
      .then((next) => {
        if (!cancelled) setCatalog(next.connectors);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const bound = new Set(view?.bindings.map((binding) => binding.accountId));
  const mine = (view?.accounts ?? []).filter(
    (account) => account.ownerUserId === currentUserId,
  );
  const others = (view?.accounts ?? []).filter(
    (account) => account.ownerUserId !== currentUserId && bound.has(account.id),
  );
  const extensionDescriptors = catalog.filter(
    (connector) =>
      connector.extension &&
      connector.holding === "server_held" &&
      connector.serverHeld,
  );
  const extensionKinds = new Set([
    ...extensionDescriptors.map((connector) => connector.kind),
    ...mine
      .map((account) => account.provider)
      .filter(
        (provider) =>
          !["feishu", "cloudflare", "appstoreconnect"].includes(provider),
      ),
  ]);
  const serverHeldTypes = ["feishu", ...extensionKinds];

  async function toggle(account: ExternalAccount, use: boolean) {
    setBindingError("");
    const accountIds = mine
      .filter((entry) => (entry.id === account.id ? use : bound.has(entry.id)))
      .map((entry) => entry.id);
    if (use && !accountIds.includes(account.id)) accountIds.push(account.id);
    setBusy(true);
    try {
      setView(await setWorkspaceExternalAccounts(workspaceId, accountIds));
      setBindingRetry(undefined);
      onNotice(
        t(use ? "workspace.bound" : "workspace.unbound", {
          name: accountName(account),
        }),
      );
    } catch (cause) {
      const message = t("workspace.saveFailed", { error: errorText(cause) });
      setBindingError(message);
      if (use) setBindingRetry(account);
      onNotice(message);
    } finally {
      setBusy(false);
    }
  }

  if (error)
    return <Alert title={t("workspace.loadFailed", { error })} tone="error" />;
  if (!view)
    return <Skeleton label={t("workspace.loading")} rows={3} variant="rows" />;
  return (
    <div className="grid min-w-0 gap-3.5">
      <MutedText>{t("workspace.rule")}</MutedText>
      {readOnlyReason ? <Alert title={readOnlyReason} tone="info" /> : null}
      {bindingError ? (
        <Alert title={bindingError} tone="error">
          {bindingRetry ? (
            <Button
              disabled={busy}
              size="sm"
              onClick={() => void toggle(bindingRetry, true)}
            >
              {t("workspace.retryBinding")}
            </Button>
          ) : null}
        </Alert>
      ) : null}
      {authorizing ? (
        <WorkspaceAccountAuthorization
          key={authorizing.account?.id ?? "new"}
          account={authorizing.account}
          onClose={() => setAuthorizing(undefined)}
          onConnected={(account) => {
            setView(
              (current) =>
                current && {
                  ...current,
                  accounts: [
                    ...current.accounts.filter((a) => a.id !== account.id),
                    account,
                  ],
                },
            );
            void toggle(account, true);
          }}
        />
      ) : null}
      {serverHeldTypes.map((type) => {
        const descriptor = extensionDescriptors.find(
          (connector) => connector.kind === type,
        );
        return (
          <WorkspaceServerHeldSection
            authorizing={Boolean(authorizing)}
            bound={bound}
            busy={busy}
            descriptor={descriptor}
            key={type}
            kind={type}
            mine={mine}
            onConnect={(account) => setAuthorizing({ account })}
            onManage={() => navigateToConnectors(type)}
            onToggle={(account, use) => void toggle(account, use)}
            readOnlyReason={readOnlyReason}
            theirs={others}
          />
        );
      })}
      <CloudflareConnector
        workspaceId={workspaceId}
        workspaceView={view}
        onWorkspaceChanged={setView}
        currentUserId={currentUserId}
        readOnlyReason={readOnlyReason}
        onNotice={onNotice}
      />
      <AppStoreConnectConnector
        workspaceId={workspaceId}
        workspaceView={view}
        onWorkspaceChanged={setView}
        currentUserId={currentUserId}
        readOnlyReason={readOnlyReason}
        onNotice={onNotice}
      />
      <WorkspaceDeviceConnectors
        key={workspaceId}
        currentUserId={currentUserId}
        onNotice={onNotice}
        readOnlyReason={readOnlyReason}
        workspaceId={workspaceId}
      />
    </div>
  );
}
