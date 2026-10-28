import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type {
  ExternalAccount,
  ExternalAccountLogin,
  ExternalProvider,
  ExternalProviderApp,
} from "@bd777/foundry-protocol";
import { connectExternalAccount } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { TextInput } from "../../components/ui/field";
import { accountName, appName, errorText } from "./account-format";
import {
  PartialGrant,
  ScanStep,
  SignInModal,
  useScopeOptions,
} from "./sign-in";
import { LoadingState } from "../../components/ui/loading";

/** A sign-in through an app on the page: renew one account, or add another Feishu user. */
export interface AuthorizeTarget {
  app: ExternalProviderApp;
  /** The account to re-authorize in place; unset authorizes another account. */
  account?: ExternalAccount;
}

export interface AuthorizeDialogProps {
  target?: AuthorizeTarget;
  provider?: ExternalProvider;
  onClose: () => void;
  onConnected: (account: ExternalAccount, renewed: boolean) => void;
}

/** One scan through an app the person already has, opened from its row. */
export function AuthorizeDialog({
  target,
  provider,
  onClose,
  onConnected,
}: AuthorizeDialogProps) {
  const { t } = useTranslation("externalAccounts");
  const app = target ? appName(target.app) : "";
  return (
    <SignInModal
      description={
        target?.account
          ? t("authorize.reauthorizeBody", { app })
          : t("authorize.anotherBody")
      }
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open={Boolean(target)}
      title={
        target?.account
          ? t("authorize.reauthorizeTitle", {
              name: accountName(target.account),
            })
          : t("authorize.anotherTitle", { app })
      }
    >
      {target ? (
        <AuthorizeFlow
          onClose={onClose}
          onConnected={onConnected}
          provider={provider}
          target={target}
        />
      ) : null}
    </SignInModal>
  );
}

function AuthorizeFlow({
  target,
  provider,
  onClose,
  onConnected,
}: Required<Pick<AuthorizeDialogProps, "target">> &
  Omit<AuthorizeDialogProps, "target">) {
  const { t } = useTranslation("externalAccounts");
  const scope = useScopeOptions(provider);
  const renewing = Boolean(target.account);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [login, setLogin] = useState<ExternalAccountLogin>();
  const [finished, setFinished] = useState<ExternalAccountLogin>();
  // Only the latest start shows: an earlier answer arriving late is dropped.
  const attempt = useRef(0);

  async function begin() {
    const mine = ++attempt.current;
    setBusy(true);
    setError("");
    setLogin(undefined);
    try {
      const started = await connectExternalAccount({
        appId: target.app.id,
        ...(target.account ? { accountId: target.account.id } : {}),
        ...(!renewing && label.trim() ? { label: label.trim() } : {}),
        ...scope.extra,
      });
      if (mine === attempt.current) setLogin(started);
    } catch (cause) {
      if (mine === attempt.current) setError(errorText(cause));
    } finally {
      if (mine === attempt.current) setBusy(false);
    }
  }

  useEffect(() => {
    void begin();
  }, []);

  function restart(event: FormEvent) {
    event.preventDefault();
    void begin();
  }

  if (finished)
    return <PartialGrant login={finished} onClose={() => onClose()} />;

  return (
    <div className="fdy-xacc-form">
      {error ? (
        <Alert title={t("connect.failed", { error })} tone="error">
          <Button onClick={() => void begin()} size="sm">
            {t("connect.tryAgain")}
          </Button>
        </Alert>
      ) : null}
      {login ? (
        <ScanStep
          key={login.id}
          login={login}
          onAppCreated={() => {}}
          onDone={(done) => {
            if (done.account) onConnected(done.account, renewing);
            if (done.missingScopes?.length) setFinished(done);
            else onClose();
          }}
          onRetry={() => void begin()}
        />
      ) : busy ? (
        <LoadingState
          className="fdy-xacc-waiting"
          label={t("connect.starting")}
        />
      ) : null}
      {scope.summary}
      <details className="fdy-xacc-advanced">
        <summary>{t("connect.advanced")}</summary>
        <form className="fdy-xacc-form" onSubmit={restart}>
          {scope.fields}
          {renewing ? null : (
            <label className="fdy-xacc-field">
              <span>{t("connect.nameLabel")}</span>
              <TextInput
                onChange={(event) => setLabel(event.target.value)}
                placeholder={t("connect.namePlaceholder")}
                tone="boxed"
                value={label}
              />
            </label>
          )}
          <span className="fdy-xacc-form-actions">
            <Button disabled={busy} type="submit">
              {t("connect.restart")}
            </Button>
          </span>
        </form>
      </details>
      <div className="fdy-xacc-form-actions">
        <Dialog.Close asChild>
          <Button variant="ghost">{t("connect.cancel")}</Button>
        </Dialog.Close>
      </div>
    </div>
  );
}
