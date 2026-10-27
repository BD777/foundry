import { Alert } from "../../components/ui/alert";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type {
  ExternalProviderApp,
  FeishuAppUse,
} from "@bd777/foundry-protocol";
import { replaceExternalAppSecret } from "../../api";
import { organisationLabel } from "../../lib/feishu-app-names";
import { navigateToWorkspaceChannels } from "../../lib/in-app-navigation";
import { Button } from "../../components/ui/button";
import { FieldHint, TextInput } from "../../components/ui/field";
import { Panel } from "../../components/ui/panel";
import { appName, errorText, relativeWhen } from "./account-format";
import { RowMenu, type RowMenuItem } from "../../components/ui/row-menu";

/** The app's credentials page in the Feishu / Lark developer console. */
function consoleCredentialsURL(app: ExternalProviderApp): string {
  const base = (app.baseUrl || "https://open.feishu.cn").replace(/\/$/, "");
  return `${base}/app/${encodeURIComponent(app.clientId)}/baseinfo`;
}

/**
 * Whether the person would ever replace the app's secret here: when devices
 * held it before Foundry's gateway, or when they pasted the app themselves
 * and may reset it in Feishu's console. An app Foundry created needs neither.
 */
export function secretReplaceable(
  app: ExternalProviderApp,
  canManage: boolean,
): boolean {
  return (
    canManage && (Boolean(app.rotateSecret) || app.createdVia === "pasted")
  );
}

/** The app's line under its name: organisation, and who shares it. */
export function appPlace(app: ExternalProviderApp, label: string): string {
  return [organisationLabel(app), label].filter(Boolean).join(" · ");
}

/**
 * What the page says about an app wherever it is shown: that its secret
 * must be rotated, the form that replaces it, and what uses it.
 */
export function AppNotes({
  app,
  canManage,
  replacing,
  use,
  onReplace,
  onCancel,
  onReplaced,
}: {
  app: ExternalProviderApp;
  canManage: boolean;
  replacing: boolean;
  /** What uses the app: workspace bots, agent subscriptions. */
  use?: FeishuAppUse;
  onReplace: () => void;
  onCancel: () => void;
  onReplaced: (app: ExternalProviderApp) => void;
}) {
  const { t } = useTranslation("externalAccounts");
  return (
    <>
      {canManage && app.rotateSecret && !replacing ? (
        <div className="fdy-xacc-app-rotate" role="status">
          <FieldHint>
            {t("apps.rotateHint", { name: appName(app) })}{" "}
            <a
              href={consoleCredentialsURL(app)}
              rel="noreferrer"
              target="_blank"
            >
              {t("apps.rotateOpenConsole")}
            </a>
          </FieldHint>
          <Button onClick={onReplace} size="sm">
            {t("apps.replaceSecret")}
          </Button>
        </div>
      ) : null}
      {replacing ? (
        <AppSecretForm app={app} onCancel={onCancel} onReplaced={onReplaced} />
      ) : null}
      {use ? <AppUses use={use} /> : null}
    </>
  );
}

function AppSecretForm({
  app,
  onCancel,
  onReplaced,
}: {
  app: ExternalProviderApp;
  onCancel: () => void;
  onReplaced: (app: ExternalProviderApp) => void;
}) {
  const { t } = useTranslation("externalAccounts");
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    if (!secret.trim()) return setError(t("connect.appSecretRequired"));
    setSaving(true);
    setError("");
    try {
      onReplaced(await replaceExternalAppSecret(app.id, secret.trim()));
    } catch (cause) {
      setError(errorText(cause));
      setSaving(false);
    }
  }

  return (
    <form
      className="fdy-xacc-app-secret"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label className="fdy-xacc-field">
        <span>{t("apps.newSecretLabel", { name: appName(app) })}</span>
        <TextInput
          autoComplete="new-password"
          autoFocus
          onChange={(event) => setSecret(event.target.value)}
          tone="boxed"
          type="password"
          value={secret}
        />
        <FieldHint as="small">{t("apps.newSecretHint")}</FieldHint>
      </label>
      {error ? <Alert tone="error" size="compact" title={error} /> : null}
      <span className="fdy-xacc-form-actions">
        <Button
          disabled={saving}
          onClick={onCancel}
          size="sm"
          type="button"
          variant="ghost"
        >
          {t("connect.cancel")}
        </Button>
        <Button disabled={saving} size="sm" type="submit" variant="primary">
          {saving ? t("actions.working") : t("apps.saveSecret")}
        </Button>
      </span>
    </form>
  );
}

/**
 * An app several of the person's accounts signed in through (a team app,
 * or older data): its name once, its notes, then the accounts.
 */
export function AppGroup({
  app,
  label,
  items,
  busy,
  notes,
  children,
}: {
  app: ExternalProviderApp;
  /** Whose app it is ("Organization app", "Your app"). */
  label: string;
  items: RowMenuItem[];
  busy: boolean;
  notes: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation("externalAccounts");
  const name = appName(app);
  return (
    <Panel className="fdy-xacc-section fdy-xacc-app">
      <div className="fdy-xacc-row-main">
        <span className="fdy-xacc-identity">
          <strong>{name}</strong>
          <small>{appPlace(app, label)}</small>
        </span>
        <RowMenu
          disabled={busy}
          items={items}
          label={t("actions.more", { name })}
        />
      </div>
      {notes}
      <ul className="fdy-xacc-list">{children}</ul>
    </Panel>
  );
}

/**
 * An app of the person's with no account connected through it: sign in
 * through it again, or remove it.
 */
export function EmptyAppRow({
  app,
  label,
  canSignIn,
  items,
  busy,
  notes,
  onSignIn,
}: {
  app: ExternalProviderApp;
  label: string;
  canSignIn: boolean;
  items: RowMenuItem[];
  busy: boolean;
  notes: ReactNode;
  onSignIn: () => void;
}) {
  const { t } = useTranslation("externalAccounts");
  const name = appName(app);
  return (
    <li className="fdy-xacc-row fdy-xacc-app-only">
      <div className="fdy-xacc-row-main">
        <span className="fdy-xacc-identity">
          <strong>{name}</strong>
          <span>{appPlace(app, label)}</span>
          <small>{t("apps.noAccounts")}</small>
        </span>
      </div>
      {notes}
      <div className="fdy-xacc-row-actions">
        <span className="fdy-xacc-row-buttons">
          {canSignIn ? (
            <Button disabled={busy} onClick={onSignIn} size="sm">
              {t("apps.authorize")}
            </Button>
          ) : null}
          <RowMenu
            disabled={busy}
            items={items}
            label={t("actions.more", { name })}
          />
        </span>
      </div>
    </li>
  );
}

/** The workspaces whose bot runs on the app (each opens its Channels
 * tab), the agent event subscriptions open on it, and its connection. */
function AppUses({ use }: { use: FeishuAppUse }) {
  const { t } = useTranslation("externalAccounts");
  const bots = use.workspaces.length + (use.otherWorkspaces ?? 0);
  if (bots === 0 && use.subscriptions === 0) return null;
  const connection =
    use.status === "connected" ||
    use.status === "connecting" ||
    use.status === "error"
      ? [
          t(`apps.uses.${use.status}`),
          use.lastEventAt
            ? t("apps.uses.lastEvent", { when: relativeWhen(use.lastEventAt) })
            : "",
        ]
          .filter(Boolean)
          .join(", ")
      : "";
  return (
    <div className="fdy-xacc-app-uses">
      <span className="fdy-xacc-app-uses-label">{t("apps.uses.label")}</span>
      {bots > 0 ? (
        <span className="fdy-xacc-app-uses-line">
          {t("apps.uses.bots")}
          {use.workspaces.map((workspace) => (
            <Button
              aria-label={t("apps.uses.openBot", { name: workspace.name })}
              key={workspace.workspaceId}
              onClick={() => navigateToWorkspaceChannels(workspace.workspaceId)}
              size="inline"
              variant="link"
            >
              {t("apps.uses.workspaceChats", {
                name: workspace.name,
                count: workspace.chats,
              })}
            </Button>
          ))}
          {use.otherWorkspaces ? (
            <span>
              {t("apps.uses.otherWorkspaces", { count: use.otherWorkspaces })}
            </span>
          ) : null}
        </span>
      ) : null}
      {use.subscriptions > 0 ? (
        <span className="fdy-xacc-app-uses-line">
          {t("apps.uses.subscriptions", { count: use.subscriptions })}
        </span>
      ) : null}
      {connection ? (
        <span className="fdy-xacc-app-uses-line" title={use.statusDetail}>
          {connection}
        </span>
      ) : null}
    </div>
  );
}
