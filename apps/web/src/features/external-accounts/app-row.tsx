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
import { ButtonRow } from "../../components/ui/button-row";
import { DividedList } from "../../components/ui/divided-list";
import { FormField } from "../../components/ui/form-field";
import { Identity } from "../../components/ui/identity";
import { RowMain } from "../../components/ui/row-main";
import { SectionPanel } from "../../components/ui/section-panel";
import { FieldHint, TextInput } from "../../components/ui/field";
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
        <div
          className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2"
          role="status"
        >
          <FieldHint className="min-w-0 flex-1 basis-80">
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
      className="grid min-w-0 gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <FormField className="fdy-xacc-field">
        <span>{t("apps.newSecretLabel", { name: appName(app) })}</span>
        <TextInput
          autoComplete="new-password"
          autoFocus
          onChange={(event) => setSecret(event.target.value)}
          tone="boxed"
          type="password"
          value={secret}
        />
        <FieldHint as="small" className="text-ink-faint">
          {t("apps.newSecretHint")}
        </FieldHint>
      </FormField>
      {error ? <Alert tone="error" size="compact" title={error} /> : null}
      <ButtonRow align="end" as="span">
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
      </ButtonRow>
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
    <SectionPanel className="fdy-xacc-app">
      <RowMain>
        <Identity as="span">
          <strong>{name}</strong>
          <small>{appPlace(app, label)}</small>
        </Identity>
        <RowMenu
          disabled={busy}
          items={items}
          label={t("actions.more", { name })}
        />
      </RowMain>
      {notes}
      <DividedList className="border-t border-line-soft">
        {children}
      </DividedList>
    </SectionPanel>
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
    <li className="fdy-xacc-row fdy-xacc-app-only grid gap-2.5">
      <RowMain>
        <Identity as="span">
          <strong>{name}</strong>
          <span>{appPlace(app, label)}</span>
          <small>{t("apps.noAccounts")}</small>
        </Identity>
      </RowMain>
      {notes}
      <ButtonRow align="between" className="gap-x-3">
        <ButtonRow as="span" className="ml-auto">
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
        </ButtonRow>
      </ButtonRow>
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
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs leading-[1.6] text-ink-muted">
      <span className="font-semibold text-ink">{t("apps.uses.label")}</span>
      {bots > 0 ? (
        <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-1.5">
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
        <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-1.5">
          {t("apps.uses.subscriptions", { count: use.subscriptions })}
        </span>
      ) : null}
      {connection ? (
        <span
          className="inline-flex min-w-0 flex-wrap items-baseline gap-x-1.5"
          title={use.statusDetail}
        >
          {connection}
        </span>
      ) : null}
    </div>
  );
}
