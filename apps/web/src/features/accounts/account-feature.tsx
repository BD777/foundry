import { HelpHint } from "../../components/ui/help-hint";
import { ToastFeedback } from "../../components/ui/toast";
import { useState, type FormEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import {
  changeMyPassword,
  updateMyDisplayName,
  updateMyLocale,
} from "../../api";
import type { AccountUser } from "../../api-types";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { FieldHint, TextInput } from "../../components/ui/field";
import { LanguageSelect } from "../../components/ui/language-select";
import { applyLocalePreference, type LocalePreference } from "../../i18n";
import { PageSurface } from "../../components/ui/page-surface";
import { ButtonRow } from "../../components/ui/button-row";
import { FormField, FormFieldGroup } from "../../components/ui/form-field";
import { SectionPanel } from "../../components/ui/section-panel";
import { roleLabel } from "./account-format";
import { serverErrorText } from "../../lib/errors";
import { PageHeader, SectionHeader } from "../../components/ui/page-header";

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
      setNameFeedback({ tone: "error", text: serverErrorText(reason) });
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
      setPasswordFeedback({ tone: "error", text: serverErrorText(reason) });
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
      setLanguageFeedback({ tone: "error", text: serverErrorText(reason) });
    } finally {
      setLanguageBusy(false);
    }
  }

  return (
    <PageSurface variant="accounts">
      <PageHeader
        title={t("page.title")}
        description={
          <>
            <Trans
              components={{ b: <b /> }}
              i18nKey="page.signedInAs"
              ns="account"
              values={{ username: user.username }}
            />{" "}
            <Badge tone={user.role === "admin" ? "brass" : "neutral"}>
              {roleLabel(user.role)}
            </Badge>
          </>
        }
      />

      <SectionPanel spacing="roomy">
        <form className="grid gap-4" onSubmit={(event) => void saveName(event)}>
          <FormField>
            <span>{t("page.displayName")}</span>
            <TextInput
              maxLength={64}
              onChange={(event) => setDisplayName(event.target.value)}
              required
              tone="boxed"
              value={displayName}
            />
            <FieldHint as="small">{t("page.displayNameHint")}</FieldHint>
          </FormField>
          {nameFeedback ? (
            <ToastFeedback tone={nameFeedback.tone} title={nameFeedback.text} />
          ) : null}
          <ButtonRow align="end">
            <Button
              disabled={nameBusy || displayName.trim() === user.displayName}
              type="submit"
              variant="primary"
            >
              {nameBusy ? t("common:actions.saving") : t("page.saveName")}
            </Button>
          </ButtonRow>
        </form>
      </SectionPanel>

      <SectionPanel spacing="roomy">
        <form
          className="grid gap-4"
          onSubmit={(event) => void savePassword(event)}
        >
          <FormField>
            <span>{t("page.currentPassword")}</span>
            <TextInput
              autoComplete="current-password"
              onChange={(event) => setCurrentPassword(event.target.value)}
              required
              tone="boxed"
              type="password"
              value={currentPassword}
            />
          </FormField>
          <FormField>
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
            <FieldHint as="small">{t("page.newPasswordHint")}</FieldHint>
          </FormField>
          {passwordFeedback ? (
            <ToastFeedback
              tone={passwordFeedback.tone}
              title={passwordFeedback.text}
            />
          ) : null}
          <ButtonRow align="end">
            <Button disabled={passwordBusy} type="submit" variant="primary">
              {passwordBusy
                ? t("page.changingPassword")
                : t("page.changePassword")}
            </Button>
          </ButtonRow>
        </form>
      </SectionPanel>

      <SectionPanel spacing="roomy">
        <FormFieldGroup>
          <span className="flex items-center gap-1.5">
            {t("common:language.label")}
            <HelpHint label={t("page.languageHelp")}>
              {t("page.languageHint")}
            </HelpHint>
          </span>
          <LanguageSelect
            disabled={languageBusy}
            onChange={(locale) => void saveLanguage(locale)}
            value={user.locale ?? ""}
          />
        </FormFieldGroup>
        {languageFeedback ? (
          <ToastFeedback
            tone={languageFeedback.tone}
            title={languageFeedback.text}
          />
        ) : null}
      </SectionPanel>

      <SectionPanel
        className="flex flex-wrap items-center justify-between gap-3"
        spacing="roomy"
      >
        <SectionHeader
          className="min-w-0 flex-1"
          level={3}
          description={t("page.signOutBody")}
          title={t("page.signOutTitle")}
        />
        <Button onClick={() => onEvent({ type: "account.signOutRequested" })}>
          {t("page.signOut")}
        </Button>
      </SectionPanel>
    </PageSurface>
  );
}
