import { useEffect, useState, type FormEvent } from "react";
import { acceptInvite, getInvite, login, setupFirstOwner } from "../../api";
import type { AuthState, InvitePreview } from "../../api-types";
import { Alert } from "../../components/ui/alert";
import {
  FoundryShell,
  type FoundryThemeMode,
} from "../../components/ui/app-shell";
import { Button } from "../../components/ui/button";
import { TextInput } from "../../components/ui/field";
import { Panel } from "../../components/ui/panel";
import { LanguageSelect } from "../../components/ui/language-select";
import { useTranslation } from "react-i18next";
import {
  applyLocalePreference,
  i18n,
  storedLocalePreference,
} from "../../i18n";
import { roleNoun } from "./account-format";
import { workspaceRoleLabel } from "../../lib/workspace-access";

export type AuthScreenKind = "login" | "setup" | "invite";

export interface AuthScreenProps {
  kind: AuthScreenKind;
  inviteToken?: string;
  theme: FoundryThemeMode;
  onAuthenticated: (state: AuthState) => void;
}

export function AuthScreen({
  kind,
  inviteToken,
  theme,
  onAuthenticated,
}: AuthScreenProps) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [setupCode, setSetupCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState<InvitePreview | undefined>();
  const [inviteError, setInviteError] = useState("");
  const { t } = useTranslation(["account", "common"]);
  const [language, setLanguage] = useState(storedLocalePreference);

  useEffect(() => {
    if (kind !== "invite" || !inviteToken) return;
    let cancelled = false;
    getInvite(inviteToken)
      .then((preview) => {
        if (!cancelled) setInvite(preview);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setInviteError(errorText(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [kind, inviteToken]);

  const creating = kind !== "login";
  const text = {
    title: t(`auth.${kind}.title`),
    body: t(`auth.${kind}.body`),
    submit: t(`auth.${kind}.submit`),
  };

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const account = { username, displayName, password };
      const state =
        kind === "setup"
          ? await setupFirstOwner({ ...account, setupCode })
          : kind === "invite"
            ? await acceptInvite(inviteToken ?? "", account)
            : await login(username, password);
      onAuthenticated(state);
    } catch (reason) {
      setError(errorText(reason));
      setBusy(false);
    }
  }

  const inviteUnavailable =
    kind === "invite" && (!!inviteError || !inviteToken);

  return (
    <FoundryShell theme={theme}>
      <div className="fdy-auth-screen">
        <Panel className="fdy-auth-card">
          <header className="fdy-auth-header">
            <img
              alt=""
              height={40}
              src={`${import.meta.env.BASE_URL}foundry-icon.png`}
              width={40}
            />
            <h1>{text.title}</h1>
            <p>
              {kind === "invite" && invite
                ? `${
                    invite.workspaceName && invite.workspaceRole
                      ? t("auth.invitedAsInWorkspace", {
                          role: roleNoun(invite.role),
                          workspace: invite.workspaceName,
                          workspaceRole: workspaceRoleLabel(
                            invite.workspaceRole,
                          ),
                        })
                      : t("auth.invitedAs", { role: roleNoun(invite.role) })
                  } ${text.body}`
                : text.body}
            </p>
          </header>
          {inviteUnavailable ? (
            <Alert
              details={inviteError || undefined}
              tone="error"
              title={t("auth.inviteUnavailableTitle")}
            >
              {t("auth.inviteUnavailableBody")}
            </Alert>
          ) : (
            <form
              className="fdy-auth-form"
              onSubmit={(event) => void submit(event)}
            >
              {kind === "setup" ? (
                <label className="fdy-auth-field">
                  <span>{t("auth.setupCode")}</span>
                  <TextInput
                    autoComplete="one-time-code"
                    autoFocus
                    onChange={(event) => setSetupCode(event.target.value)}
                    placeholder={t("auth.setupCodePlaceholder")}
                    required
                    tone="boxed"
                    value={setupCode}
                  />
                </label>
              ) : null}
              <label className="fdy-auth-field">
                <span>{t("auth.username")}</span>
                <TextInput
                  autoComplete="username"
                  autoFocus={kind !== "setup"}
                  onChange={(event) => setUsername(event.target.value)}
                  required
                  tone="boxed"
                  value={username}
                />
                {creating ? <small>{t("auth.usernameHint")}</small> : null}
              </label>
              {creating ? (
                <label className="fdy-auth-field">
                  <span>{t("auth.displayNameOptional")}</span>
                  <TextInput
                    autoComplete="name"
                    maxLength={64}
                    onChange={(event) => setDisplayName(event.target.value)}
                    tone="boxed"
                    value={displayName}
                  />
                </label>
              ) : null}
              <label className="fdy-auth-field">
                <span>{t("auth.password")}</span>
                <TextInput
                  autoComplete={creating ? "new-password" : "current-password"}
                  minLength={creating ? 10 : undefined}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  tone="boxed"
                  type="password"
                  value={password}
                />
                {creating ? <small>{t("auth.passwordHint")}</small> : null}
              </label>
              {error ? (
                <Alert tone="error" title={t("auth.failedTitle")}>
                  {error}
                </Alert>
              ) : null}
              <Button disabled={busy} type="submit" variant="primary">
                {busy ? t("common:actions.pleaseWait") : text.submit}
              </Button>
            </form>
          )}
          <LanguageSelect
            className="fdy-auth-language"
            onChange={(next) => {
              setLanguage(next);
              void applyLocalePreference(next);
            }}
            value={language}
          />
        </Panel>
      </div>
    </FoundryShell>
  );
}

function errorText(reason: unknown): string {
  return reason instanceof Error && reason.message
    ? reason.message
    : i18n.t("common:errors.serverUnreachable");
}
