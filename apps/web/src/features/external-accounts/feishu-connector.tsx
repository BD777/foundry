import type { ToastTone } from "../../components/ui/toast";
import { Plus } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type {
  ExternalAccount,
  ExternalAccountsView,
  ExternalProviderApp,
  FeishuAppUse,
} from "@bd777/foundry-protocol";
import {
  deleteExternalApp,
  disconnectExternalAccount,
  getExternalAccounts,
  getFeishuAppUses,
  refreshExternalAccount,
  revokeExternalAccount,
  updateExternalAccount,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { Panel } from "../../components/ui/panel";
import { tenantNameScopeHint } from "../../lib/feishu-app-names";
import {
  accountName,
  accountPlace,
  appName,
  errorText,
} from "./account-format";
import { AccountRow, type AccountAction } from "./account-row";
import { AppGroup, AppNotes, EmptyAppRow, secretReplaceable } from "./app-row";
import { AuthorizeDialog, type AuthorizeTarget } from "./authorize-dialog";
import { ConnectDialog } from "./connect-dialog";
import { LinkQrDialog, type LinkQrTarget } from "./link-qr-dialog";
import type { RowMenuItem } from "../../components/ui/row-menu";
import { Skeleton } from "../../components/ui/loading";

export interface FeishuConnectorProps {
  currentUserId: string;
  isAdmin: boolean;
  onNotice: (message: string, tone?: ToastTone) => void;
}

const provider = "feishu";

/**
 * The Connectors page's Feishu tab: one row per connected account, named by
 * the person, their organisation and the app. The top button adds an
 * account; everything about what is connected is an action on its row. App
 * matters (a secret to replace, an app no account uses) show only where they
 * apply. Read on open and after each action; the server publishes no events
 * for accounts.
 */
export function FeishuConnector({
  currentUserId,
  isAdmin,
  onNotice,
}: FeishuConnectorProps) {
  const { t } = useTranslation(["externalAccounts", "common"]);
  const [view, setView] = useState<ExternalAccountsView>();
  const [loadError, setLoadError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [linkQr, setLinkQr] = useState<LinkQrTarget>();
  const [authorizing, setAuthorizing] = useState<AuthorizeTarget>();
  const [uses, setUses] = useState<FeishuAppUse[]>([]);
  const [replacing, setReplacing] = useState("");

  async function load() {
    try {
      setView(await getExternalAccounts());
      setLoadError("");
    } catch (cause) {
      setLoadError(errorText(cause));
    }
    // What uses each app is a detail: the page stands without it.
    getFeishuAppUses().then(setUses, () => setUses([]));
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
    if (action === "reconnect" || action === "reauthorize") {
      const app = view?.apps.find((entry) => entry.id === account.appId);
      if (app) setAuthorizing({ app, account });
      return;
    }
    const name = accountName(account);
    setBusyId(account.id);
    try {
      switch (action) {
        case "refresh":
          showAccount(await refreshExternalAccount(account.id));
          onNotice(t("notices.refreshed", { name }));
          // The refresh may have read the app's names again.
          void load();
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
      onNotice(t("notices.failed", { error: errorText(cause) }), "error");
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
      onNotice(t("notices.appRemoved", { name: appName(app) }));
    } catch (cause) {
      onNotice(t("notices.failed", { error: errorText(cause) }), "error");
    } finally {
      setBusyId("");
    }
  }

  const accounts = (view?.accounts ?? []).filter(
    (account) => account.provider === provider,
  );
  const apps = (view?.apps ?? []).filter((app) => app.provider === provider);
  const providerView = view?.providers.find((entry) => entry.kind === provider);
  const canConnect = Boolean(view?.secretsConfigured);
  const through = (app: ExternalProviderApp) =>
    accounts.filter((account) => account.appId === app.id);
  const orphans = accounts.filter(
    (account) => !apps.some((app) => app.id === account.appId),
  );
  const teamApps = apps.filter(
    (app) =>
      app.visibility === "instance" &&
      app.hasSecret &&
      !app.rotateSecret &&
      through(app).length === 0,
  );
  const canManage = (app: ExternalProviderApp) =>
    app.ownerUserId === currentUserId ||
    (isAdmin && app.visibility === "instance");
  const whose = (app: ExternalProviderApp) =>
    t(app.visibility === "instance" ? "apps.instance" : "apps.personal");
  // Replacing a secret is offered where it is ever needed; while devices
  // still hold the old one the app's note shows it instead. The company's
  // full name is optional (its email domain stands in), so the permission
  // it needs is offered only here.
  const appItems = (app: ExternalProviderApp): RowMenuItem[] => {
    const items: RowMenuItem[] = [];
    if (secretReplaceable(app, canManage(app)) && !app.rotateSecret) {
      items.push({
        key: "secret",
        label: t("apps.replaceSecret"),
        onSelect: () => setReplacing(app.id),
      });
    }
    const tenantScope = canManage(app) ? tenantNameScopeHint(app) : undefined;
    if (tenantScope) {
      items.push({
        key: "tenant-name",
        label: t("apps.showTenantName"),
        onSelect: () =>
          setLinkQr({
            title: t("linkQr.tenantTitle"),
            description: t("linkQr.tenantDescription"),
            url: tenantScope.url,
          }),
      });
    }
    return items;
  };
  const notes = (app: ExternalProviderApp) => (
    <AppNotes
      app={app}
      canManage={canManage(app)}
      onCancel={() => setReplacing("")}
      onReplace={() => setReplacing(app.id)}
      onReplaced={(saved) => {
        setReplacing("");
        setView(
          (current) =>
            current && {
              ...current,
              apps: current.apps.map((entry) =>
                entry.id === saved.id ? saved : entry,
              ),
            },
        );
        onNotice(t("notices.secretReplaced", { name: appName(saved) }));
      }}
      replacing={replacing === app.id}
      use={uses.find((use) => use.appId === app.id)}
    />
  );
  const accountRow = (
    account: ExternalAccount,
    app: ExternalProviderApp | undefined,
    place: string,
    extra?: { items: RowMenuItem[]; notes: ReactNode },
  ) => (
    <AccountRow
      account={account}
      appItems={extra?.items}
      busy={busyId === account.id}
      canReauthorize={Boolean(app)}
      key={account.id}
      onAction={(action) => void act(account, action)}
      place={place}
    >
      {extra?.notes}
    </AccountRow>
  );
  // One row per connected account, naming its organisation and app; an app
  // several of the person's accounts share lists them under its name once.
  const rows: ReactNode[] = [];
  const emptyApps: ReactNode[] = [];
  const groups: ReactNode[] = [];
  for (const app of apps) {
    const own = through(app);
    const [only] = own;
    if (only && own.length === 1) {
      rows.push(
        accountRow(only, app, accountPlace(only, app), {
          items: appItems(app),
          notes: notes(app),
        }),
      );
    } else if (own.length > 1) {
      groups.push(
        <AppGroup
          app={app}
          busy={busyId === app.id}
          items={appItems(app)}
          key={app.id}
          label={whose(app)}
          notes={notes(app)}
        >
          {own.map((account) => accountRow(account, app, ""))}
        </AppGroup>,
      );
    } else if (canManage(app)) {
      const name = appName(app);
      emptyApps.push(
        <EmptyAppRow
          app={app}
          busy={busyId === app.id}
          canSignIn={canConnect && app.hasSecret && !app.rotateSecret}
          items={[
            ...appItems(app),
            {
              key: "remove-app",
              tone: "danger" as const,
              label: t("apps.remove"),
              onSelect: () => void removeApp(app),
              confirm: {
                title: t("apps.removeTitle", { name }),
                body: t("apps.removeBody"),
                action: t("apps.remove"),
              },
            },
          ]}
          key={app.id}
          label={whose(app)}
          notes={notes(app)}
          onSignIn={() => setAuthorizing({ app })}
        />,
      );
    }
  }
  for (const account of orphans)
    rows.push(accountRow(account, undefined, accountPlace(account, undefined)));
  return (
    <div className="fdy-xacc-tab">
      <div className="fdy-xacc-intro">
        <span>
          <p>{t("feishu.intro")}</p>
        </span>
        <Button
          disabled={!canConnect}
          onClick={() => setConnecting(true)}
          size="sm"
          variant="primary"
        >
          <Plus size={14} />
          {t("feishu.connect")}
        </Button>
      </div>
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
        <Skeleton label={t("page.loading")} rows={3} variant="rows" />
      ) : null}
      {view && rows.length + emptyApps.length + groups.length === 0 ? (
        <Panel className="fdy-xacc-section">
          <EmptyState title={t("list.emptyTitle")} body={t("list.emptyBody")} />
        </Panel>
      ) : null}
      {rows.length + emptyApps.length ? (
        <Panel className="fdy-xacc-section">
          <ul className="fdy-xacc-list">
            {rows}
            {emptyApps}
          </ul>
        </Panel>
      ) : null}
      {groups}
      <LinkQrDialog onClose={() => setLinkQr(undefined)} target={linkQr} />
      <ConnectDialog
        isAdmin={isAdmin}
        onAppCreated={(app) =>
          setView(
            (current) =>
              current && {
                ...current,
                apps: [
                  ...current.apps.filter((entry) => entry.id !== app.id),
                  app,
                ],
              },
          )
        }
        onConnected={(account) => {
          showAccount(account);
          onNotice(t("notices.connected", { name: accountName(account) }));
          void load();
        }}
        onOpenChange={setConnecting}
        open={connecting}
        provider={providerView}
        teamApps={teamApps}
      />
      <AuthorizeDialog
        onClose={() => setAuthorizing(undefined)}
        onConnected={(account, renewed) => {
          showAccount(account);
          onNotice(
            t(renewed ? "notices.reauthorized" : "notices.connected", {
              name: accountName(account),
            }),
          );
          void load();
        }}
        provider={providerView}
        target={authorizing}
      />
    </div>
  );
}
