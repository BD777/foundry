import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ExternalProviderApp,
  FeishuAppUse,
} from "@bd777/foundry-protocol";
import { replaceExternalAppSecret } from "../../api";
import { navigateToWorkspaceFeishuBot } from "../../lib/in-app-navigation";
import { Button } from "../../components/ui/button";
import { ConfirmButton } from "../../components/ui/confirm-button";
import { TextInput } from "../../components/ui/field";
import { errorText, relativeWhen } from "./account-format";

/** The app's credentials page in the Feishu / Lark developer console. */
function consoleCredentialsURL(app: ExternalProviderApp): string {
  const base = (app.baseUrl || "https://open.feishu.cn").replace(/\/$/, "");
  return `${base}/app/${encodeURIComponent(app.clientId)}/baseinfo`;
}

/**
 * One Feishu app on the Connectors page. Who may manage it can replace its
 * secret after rotating it in the developer console; an app whose secret
 * devices held before Foundry's gateway says so, once, in one line.
 */
export function AppRow({
  app,
  canManage,
  busy,
  onRemove,
  onReplaced,
  use,
}: {
  app: ExternalProviderApp;
  /** What uses the app: workspace bots, agent subscriptions. */
  use?: FeishuAppUse;
  canManage: boolean;
  busy: boolean;
  onRemove: () => void;
  onReplaced: (app: ExternalProviderApp) => void;
}) {
  const { t } = useTranslation("externalAccounts");
  const [replacing, setReplacing] = useState(false);
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    if (!secret.trim()) return setError(t("connect.appSecretRequired"));
    setSaving(true);
    setError("");
    try {
      const saved = await replaceExternalAppSecret(app.id, secret.trim());
      setSecret("");
      setReplacing(false);
      onReplaced(saved);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <li className="fdy-xacc-app">
      <div className="fdy-xacc-row-main">
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
        {canManage && !replacing ? (
          <span className="fdy-xacc-row-buttons">
            <Button
              disabled={busy}
              onClick={() => setReplacing(true)}
              size="sm"
            >
              {t("apps.replaceSecret")}
            </Button>
            <ConfirmButton
              confirmLabel={t("apps.removeConfirm")}
              disabled={busy}
              onConfirm={onRemove}
              size="sm"
              variant="ghost"
            >
              {t("apps.remove")}
            </ConfirmButton>
          </span>
        ) : null}
      </div>
      {use ? <AppUses use={use} /> : null}
      {canManage && app.rotateSecret ? (
        <p className="fdy-xacc-row-detail" role="status">
          {t("apps.rotateHint")}{" "}
          <a href={consoleCredentialsURL(app)} rel="noreferrer" target="_blank">
            {t("apps.rotateOpenConsole")}
          </a>
        </p>
      ) : null}
      {replacing ? (
        <form
          className="fdy-xacc-app-secret"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label className="fdy-xacc-field">
            <span>{t("apps.newSecretLabel")}</span>
            <TextInput
              autoComplete="new-password"
              autoFocus
              onChange={(event) => setSecret(event.target.value)}
              tone="boxed"
              type="password"
              value={secret}
            />
            <small>{t("apps.newSecretHint")}</small>
          </label>
          {error ? (
            <p className="fdy-xacc-row-detail" role="alert">
              {error}
            </p>
          ) : null}
          <span className="fdy-xacc-form-actions">
            <Button
              disabled={saving}
              onClick={() => {
                setReplacing(false);
                setSecret("");
                setError("");
              }}
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
      ) : null}
    </li>
  );
}

/** The workspaces whose bot runs on the app (each opens its Feishu Bot
 * tab), the agent event subscriptions open on it, and its connection. */
function AppUses({ use }: { use: FeishuAppUse }) {
  const { t } = useTranslation("externalAccounts");
  const bots = use.workspaces.length + (use.otherWorkspaces ?? 0);
  if (bots === 0 && use.subscriptions === 0)
    return <p className="fdy-xacc-muted">{t("apps.uses.unused")}</p>;
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
              onClick={() =>
                navigateToWorkspaceFeishuBot(workspace.workspaceId)
              }
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
