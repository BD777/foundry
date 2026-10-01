import { useState, type FormEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import {
  changeMyPassword,
  updateMyDisplayName,
  updateMyLocale,
} from "../../api";
import type { AccountUser } from "../../api-types";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { TextInput } from "../../components/ui/field";
import { LanguageSelect } from "../../components/ui/language-select";
import { applyLocalePreference, i18n, type LocalePreference } from "../../i18n";
import { PageSurface } from "../../components/ui/page-surface";
import { Panel } from "../../components/ui/panel";
import { roleLabel } from "./account-format";

export type AccountFeatureEvent =
  | { type: "account.updated"; user: AccountUser }
  | { type: "account.signOutRequested" };

export interface AccountFeatureProps {
  user: AccountUser;
  onEvent: (event: AccountFeatureEvent) => void;
}

type Feedback = { tone: "success" | "error"; text: string } | undefined;

export function AccountFeature({ user, onEvent }: AccountFeatureProps) {
  const { t } = useTranslation(["account", "common"]);
  const [languageBusy, setLanguageBusy] = useState(false);
  const [languageFeedback, setLanguageFeedback] = useState<Feedback>();
  const [displayName, setDisplayName] = useState(user.displayName);
  const [nameBusy, setNameBusy] = useState(false);
  const [nameFeedback, setNameFeedback] = useState<Feedback>();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordFeedback, setPasswordFeedback] = useState<Feedback>();

  async function saveName(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setNameBusy(true);
    setNameFeedback(undefined);
    try {
      const updated = await updateMyDisplayName(displayName);
      onEvent({ type: "account.updated", user: updated });
      setNameFeedback({ tone: "success", text: t("page.nameSaved") });
    } catch (reason) {
      setNameFeedback({ tone: "error", text: messageOf(reason) });
    } finally {
      setNameBusy(false);
    }
  }

  async function savePassword(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    setPasswordBusy(true);
    setPasswordFeedback(undefined);
    try {
      await changeMyPassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setPasswordFeedback({ tone: "success", text: t("page.passwordChanged") });
    } catch (reason) {
      setPasswordFeedback({ tone: "error", text: messageOf(reason) });
    } finally {
      setPasswordBusy(false);
    }
  }

  async function saveLanguage(locale: LocalePreference): Promise<void> {
    setLanguageBusy(true);
    setLanguageFeedback(undefined);
    try {
      // This browser remembers the same choice ("" clears it), so following
      // the browser is not undone by an earlier choice made here.
      await applyLocalePreference(locale);
      onEvent({ type: "account.updated", user: await updateMyLocale(locale) });
    } catch (reason) {
      setLanguageFeedback({ tone: "error", text: messageOf(reason) });
    } finally {
      setLanguageBusy(false);
    }
  }

  return (
    <PageSurface variant="accounts">
      <div className="fdy-account-intro">
        <strong>{t("page.title")}</strong>
        <p>
          <Trans
            components={{ b: <b /> }}
            i18nKey="page.signedInAs"
            ns="account"
            values={{ username: user.username }}
          />{" "}
          <Badge tone={user.role === "admin" ? "brass" : "neutral"}>
            {roleLabel(user.role)}
          </Badge>
        </p>
      </div>

      <Panel className="fdy-account-section">
        <form
          className="fdy-account-form"
          onSubmit={(event) => void saveName(event)}
        >
          <label className="fdy-auth-field">
            <span>{t("page.displayName")}</span>
            <TextInput
              maxLength={64}
              onChange={(event) => setDisplayName(event.target.value)}
              required
              tone="boxed"
              value={displayName}
            />
            <small>{t("page.displayNameHint")}</small>
          </label>
          {nameFeedback ? (
            <Alert tone={nameFeedback.tone} title={nameFeedback.text} />
          ) : null}
          <div className="fdy-account-actions">
            <Button
              disabled={nameBusy || displayName.trim() === user.displayName}
              type="submit"
              variant="primary"
            >
              {nameBusy ? t("common:actions.saving") : t("page.saveName")}
            </Button>
          </div>
        </form>
      </Panel>

      <Panel className="fdy-account-section">
        <form
          className="fdy-account-form"
          onSubmit={(event) => void savePassword(event)}
        >
          <label className="fdy-auth-field">
            <span>{t("page.currentPassword")}</span>
            <TextInput
              autoComplete="current-password"
              onChange={(event) => setCurrentPassword(event.target.value)}
              required
              tone="boxed"
              type="password"
              value={currentPassword}
            />
          </label>
          <label className="fdy-auth-field">
            <span>{t("page.newPassword")}</span>
            <TextInput
              autoComplete="new-password"
              minLength={10}
              onChange={(event) => setNewPassword(event.target.value)}
              required
              tone="boxed"
              type="password"
              value={newPassword}
            />
            <small>{t("page.newPasswordHint")}</small>
          </label>
          {passwordFeedback ? (
            <Alert tone={passwordFeedback.tone} title={passwordFeedback.text} />
          ) : null}
          <div className="fdy-account-actions">
            <Button disabled={passwordBusy} type="submit" variant="primary">
              {passwordBusy
                ? t("page.changingPassword")
                : t("page.changePassword")}
            </Button>
          </div>
        </form>
      </Panel>

      <Panel className="fdy-account-section">
        <div className="fdy-auth-field">
          <span>{t("common:language.label")}</span>
          <LanguageSelect
            disabled={languageBusy}
            onChange={(locale) => void saveLanguage(locale)}
            value={user.locale ?? ""}
          />
          <small>{t("page.languageHint")}</small>
        </div>
        {languageFeedback ? (
          <Alert tone={languageFeedback.tone} title={languageFeedback.text} />
        ) : null}
      </Panel>

      <Panel className="fdy-account-section fdy-account-signout">
        <div>
          <strong>{t("page.signOutTitle")}</strong>
          <p>{t("page.signOutBody")}</p>
        </div>
        <Button onClick={() => onEvent({ type: "account.signOutRequested" })}>
          {t("page.signOut")}
        </Button>
      </Panel>
    </PageSurface>
  );
}

function messageOf(reason: unknown): string {
  return reason instanceof Error && reason.message
    ? reason.message
    : i18n.t("common:errors.serverUnreachable");
}
