import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ExternalAccount,
  ExternalAccountsView,
  ExternalProviderApp,
} from "@bd777/foundry-protocol";
import {
  deleteExternalApp,
  disconnectExternalAccount,
  getExternalAccounts,
  refreshExternalAccount,
  revokeExternalAccount,
  updateExternalAccount,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { ConfirmButton } from "../../components/ui/confirm-button";
import { EmptyState } from "../../components/ui/empty-state";
import { PageSurface } from "../../components/ui/page-surface";
import { Panel } from "../../components/ui/panel";
import { accountName, errorText } from "./account-format";
import { AccountRow, type AccountAction } from "./account-row";
import { ConnectDialog } from "./connect-dialog";

export interface ExternalAccountsFeatureProps {
  currentUserId: string;
  isAdmin: boolean;
  onNotice: (message: string) => void;
}

/**
 * The External accounts page: a person's own logins at other platforms and
 * the provider apps they connect through. Read on open and after each
 * action; the server publishes no events for accounts.
 */
export function ExternalAccountsFeature({
  currentUserId,
  isAdmin,
  onNotice,
}: ExternalAccountsFeatureProps) {
  const { t } = useTranslation(["externalAccounts", "common"]);
  const [view, setView] = useState<ExternalAccountsView>();
  const [loadError, setLoadError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [connecting, setConnecting] = useState<{ appId?: string }>();

  async function load() {
    try {
      setView(await getExternalAccounts());
      setLoadError("");
    } catch (cause) {
      setLoadError(errorText(cause));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function showAccount(account: ExternalAccount) {
    setView(
      (current) =>
        current && {
          ...current,
          accounts: current.accounts.some((entry) => entry.id === account.id)
            ? current.accounts.map((entry) =>
                entry.id === account.id ? account : entry,
              )
            : [...current.accounts, account],
        },
    );
  }

  async function act(account: ExternalAccount, action: AccountAction) {
    if (action === "reconnect") {
      setConnecting({ appId: account.appId });
      return;
    }
    const name = accountName(account);
    setBusyId(account.id);
    try {
      switch (action) {
        case "refresh":
          showAccount(await refreshExternalAccount(account.id));
          onNotice(t("notices.refreshed", { name }));
          break;
        case "revoke":
          showAccount(await revokeExternalAccount(account.id));
          onNotice(t("notices.revoked", { name }));
          break;
        case "remove":
          await disconnectExternalAccount(account.id);
          setView(
            (current) =>
              current && {
                ...current,
                accounts: current.accounts.filter(
                  (entry) => entry.id !== account.id,
                ),
              },
          );
          onNotice(t("notices.removed", { name }));
          break;
        case "keep-alive-on":
        case "keep-alive-off": {
          const keepAlive = action === "keep-alive-on";
          showAccount(await updateExternalAccount(account.id, { keepAlive }));
          onNotice(
            t(keepAlive ? "notices.keepAliveOn" : "notices.keepAliveOff", {
              name,
            }),
          );
          break;
        }
      }
    } catch (cause) {
      onNotice(t("notices.failed", { error: errorText(cause) }));
      // What failed may have changed the account anyway (a refresh that
      // found it revoked): show what the server holds now.
      void load();
    } finally {
      setBusyId("");
    }
  }

  async function removeApp(app: ExternalProviderApp) {
    setBusyId(app.id);
    try {
      await deleteExternalApp(app.id);
      setView(
        (current) =>
          current && {
            ...current,
            apps: current.apps.filter((entry) => entry.id !== app.id),
          },
      );
      onNotice(t("notices.appRemoved", { name: app.label }));
    } catch (cause) {
      onNotice(t("notices.failed", { error: errorText(cause) }));
    } finally {
      setBusyId("");
    }
  }

  const accounts = view?.accounts ?? [];
  const apps = view?.apps ?? [];
  const canConnect = Boolean(view?.secretsConfigured);
  return (
    <PageSurface variant="externalAccounts">
      <header className="fdy-xacc-intro">
        <span>
          <strong>{t("page.title")}</strong>
          <p>{t("page.intro")}</p>
        </span>
        <Button
          disabled={!canConnect}
          onClick={() => setConnecting({})}
          size="sm"
          variant="primary"
        >
          <Plus size={14} />
          {t("page.connect")}
        </Button>
      </header>
      {loadError ? (
        <Alert title={t("page.loadFailed", { error: loadError })} tone="error">
          <Button onClick={() => void load()} size="sm">
            {t("common:actions.retry")}
          </Button>
        </Alert>
      ) : null}
      {view && !view.secretsConfigured ? (
        <Alert title={t("page.secretsMissing")} tone="warning" />
      ) : null}
      {!view && !loadError ? (
        <p className="fdy-xacc-muted" role="status">
          {t("page.loading")}
        </p>
      ) : null}
      {view ? (
        <Panel className="fdy-xacc-section">
          <div className="fdy-xacc-section-head">
            <strong>{t("list.title")}</strong>
            <em>{t("list.count", { count: accounts.length })}</em>
          </div>
          {accounts.length === 0 ? (
            <EmptyState
              title={t("list.emptyTitle")}
              body={t("list.emptyBody")}
            />
          ) : (
            <ul className="fdy-xacc-list">
              {accounts.map((account) => (
                <AccountRow
                  account={account}
                  app={apps.find((app) => app.id === account.appId)}
                  busy={busyId === account.id}
                  key={account.id}
                  onAction={(action) => void act(account, action)}
                  provider={view.providers.find(
                    (provider) => provider.kind === account.provider,
                  )}
                />
              ))}
            </ul>
          )}
          {accounts.length > 0 ? (
            <p className="fdy-xacc-muted">{t("page.actionsNote")}</p>
          ) : null}
        </Panel>
      ) : null}
      {view ? (
        <Panel className="fdy-xacc-section">
          <div className="fdy-xacc-section-head">
            <strong>{t("apps.title")}</strong>
            <p>{t("apps.intro")}</p>
          </div>
          {apps.length === 0 ? (
            <p className="fdy-xacc-muted">{t("apps.empty")}</p>
          ) : (
            <ul className="fdy-xacc-list">
              {apps.map((app) => (
                <li className="fdy-xacc-app-row" key={app.id}>
                  <span className="fdy-xacc-identity">
                    <strong>{app.label}</strong>
                    <small>
                      {[
                        app.visibility === "instance"
                          ? t("apps.instance")
                          : t("apps.personal"),
                        app.clientId,
                        app.baseUrl,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </small>
                  </span>
                  {app.ownerUserId === currentUserId ||
                  (isAdmin && app.visibility === "instance") ? (
                    <ConfirmButton
                      confirmLabel={t("apps.removeConfirm")}
                      disabled={busyId === app.id}
                      onConfirm={() => void removeApp(app)}
                      size="sm"
                      variant="ghost"
                    >
                      {t("apps.remove")}
                    </ConfirmButton>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      ) : null}
      <ConnectDialog
        apps={apps}
        initialAppId={connecting?.appId}
        isAdmin={isAdmin}
        onAppCreated={(app) =>
          setView(
            (current) =>
              current && { ...current, apps: [...current.apps, app] },
          )
        }
        onConnected={(account) => {
          showAccount(account);
          onNotice(t("notices.connected", { name: accountName(account) }));
          void load();
        }}
        onOpenChange={(open) => {
          if (!open) setConnecting(undefined);
        }}
        open={Boolean(connecting)}
      />
    </PageSurface>
  );
}
