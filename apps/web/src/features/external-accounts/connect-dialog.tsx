import * as Dialog from "@radix-ui/react-dialog";
import { ExternalLink, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type {
  ExternalAccount,
  ExternalAccountLogin,
  ExternalProviderApp,
} from "@bd777/foundry-protocol";
import {
  connectExternalAccount,
  createExternalApp,
  getExternalAccountLogin,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Checkbox, TextInput } from "../../components/ui/field";
import { SelectMenu } from "../../components/ui/select-menu";
import { countdown, errorText } from "./account-format";

const ownApp = "own";

export interface ConnectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  apps: ExternalProviderApp[];
  /** The app to sign in through again (a reconnect). */
  initialAppId?: string;
  isAdmin: boolean;
  onAppCreated: (app: ExternalProviderApp) => void;
  onConnected: (account: ExternalAccount) => void;
}

export function ConnectDialog(props: ConnectDialogProps) {
  const { t } = useTranslation("externalAccounts");
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fdy-xacc-modal-overlay" />
        <Dialog.Content className="fdy-xacc-modal">
          <header className="fdy-xacc-modal-header">
            <div>
              <Dialog.Title>{t("connect.title")}</Dialog.Title>
              <Dialog.Description>
                {t("connect.description")}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button
                aria-label={t("connect.close")}
                size="icon"
                variant="ghost"
              >
                <X size={16} />
              </Button>
            </Dialog.Close>
          </header>
          {props.open ? <ConnectFlow {...props} /> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ConnectFlow({
  apps,
  initialAppId,
  isAdmin,
  onAppCreated,
  onConnected,
  onOpenChange,
}: ConnectDialogProps) {
  const { t } = useTranslation("externalAccounts");
  const [appChoice, setAppChoice] = useState(
    initialAppId ?? apps[0]?.id ?? ownApp,
  );
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [shared, setShared] = useState(false);
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [login, setLogin] = useState<ExternalAccountLogin>();

  async function start(event: FormEvent) {
    event.preventDefault();
    if (appChoice === ownApp && !clientId.trim())
      return setError(t("connect.appIdRequired"));
    if (appChoice === ownApp && !clientSecret.trim())
      return setError(t("connect.appSecretRequired"));
    setBusy(true);
    setError("");
    try {
      let appId = appChoice;
      if (appChoice === ownApp) {
        const app = await createExternalApp({
          provider: "feishu",
          label: "",
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim(),
          baseUrl: baseUrl.trim() || undefined,
          visibility: shared ? "instance" : "personal",
        });
        setClientSecret("");
        onAppCreated(app);
        setAppChoice(app.id);
        appId = app.id;
      }
      setLogin(
        await connectExternalAccount({
          appId,
          label: label.trim() || undefined,
          scopes: scopes.split(/[\s,]+/).filter(Boolean),
        }),
      );
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  if (login)
    return (
      <LoginCode
        login={login}
        onDone={(account) => {
          onConnected(account);
          onOpenChange(false);
        }}
        onRetry={() => setLogin(undefined)}
      />
    );

  const appOptions = [
    ...apps.map((app) => ({
      value: app.id,
      label: app.label,
      meta: `${app.visibility === "instance" ? t("apps.instance") : t("apps.personal")} · ${app.clientId}`,
    })),
    {
      value: ownApp,
      label: t("connect.ownApp"),
      meta: t("connect.ownAppMeta"),
    },
  ];
  return (
    <form className="fdy-xacc-form" onSubmit={(event) => void start(event)}>
      {error ? (
        <Alert title={t("connect.failed", { error })} tone="error" />
      ) : null}
      <div className="fdy-xacc-field">
        <span>{t("connect.appLabel")}</span>
        <SelectMenu
          ariaLabel={t("connect.appLabel")}
          insideDialog
          onChange={setAppChoice}
          options={appOptions}
          value={appChoice}
        />
      </div>
      {appChoice === ownApp ? (
        <>
          <label className="fdy-xacc-field">
            <span>{t("connect.appIdLabel")}</span>
            <TextInput
              autoComplete="off"
              onChange={(event) => setClientId(event.target.value)}
              placeholder={t("connect.appIdPlaceholder")}
              tone="boxed"
              value={clientId}
            />
          </label>
          <label className="fdy-xacc-field">
            <span>{t("connect.appSecretLabel")}</span>
            <TextInput
              autoComplete="new-password"
              onChange={(event) => setClientSecret(event.target.value)}
              tone="boxed"
              type="password"
              value={clientSecret}
            />
            <small>{t("connect.appSecretHint")}</small>
          </label>
          <label className="fdy-xacc-field">
            <span>{t("connect.baseUrlLabel")}</span>
            <TextInput
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder={t("connect.baseUrlPlaceholder")}
              tone="boxed"
              value={baseUrl}
            />
            <small>{t("connect.baseUrlHint")}</small>
          </label>
          {isAdmin ? (
            <label className="fdy-xacc-check">
              <Checkbox
                checked={shared}
                onChange={(event) => setShared(event.currentTarget.checked)}
              />
              <span>
                {t("connect.shareLabel")}
                <small>{t("connect.shareHint")}</small>
              </span>
            </label>
          ) : null}
        </>
      ) : null}
      <label className="fdy-xacc-field">
        <span>{t("connect.scopesLabel")}</span>
        <TextInput
          onChange={(event) => setScopes(event.target.value)}
          placeholder={t("connect.scopesPlaceholder")}
          tone="boxed"
          value={scopes}
        />
        <small>{t("connect.scopesHint")}</small>
      </label>
      <label className="fdy-xacc-field">
        <span>{t("connect.nameLabel")}</span>
        <TextInput
          onChange={(event) => setLabel(event.target.value)}
          placeholder={t("connect.namePlaceholder")}
          tone="boxed"
          value={label}
        />
      </label>
      <div className="fdy-xacc-form-actions">
        <Dialog.Close asChild>
          <Button disabled={busy} variant="ghost">
            {t("connect.cancel")}
          </Button>
        </Dialog.Close>
        <Button disabled={busy} type="submit" variant="primary">
          {busy ? t("connect.starting") : t("connect.start")}
        </Button>
      </div>
    </form>
  );
}

/** The code to approve, polled until the login completes, fails or expires. */
function LoginCode({
  login: started,
  onDone,
  onRetry,
}: {
  login: ExternalAccountLogin;
  onDone: (account: ExternalAccount) => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation(["externalAccounts", "common"]);
  const [login, setLogin] = useState(started);
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState("");
  const expired =
    login.status === "pending" &&
    Boolean(login.expiresAt) &&
    now > Date.parse(login.expiresAt ?? "");

  useEffect(() => {
    let cancelled = false;
    const interval = Math.max(2, started.intervalSeconds ?? 0) * 1000;
    const tick = async () => {
      while (!cancelled) {
        await new Promise((settle) => setTimeout(settle, interval));
        if (cancelled) return;
        try {
          const next = await getExternalAccountLogin(started.id);
          if (cancelled) return;
          setLogin(next);
          if (next.status === "complete" && next.account)
            return onDone(next.account);
          if (next.status !== "pending") return;
        } catch (cause) {
          if (cancelled) return;
          setLogin((current) => ({
            ...current,
            status: "failed",
            error: errorText(cause),
          }));
          return;
        }
        if (
          started.expiresAt &&
          Date.now() > Date.parse(started.expiresAt) + 30_000
        )
          return;
      }
    };
    void tick();
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(clock);
    };
  }, [started.id]);

  async function copy(kind: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
    } catch {
      setCopied("");
    }
  }

  const link = login.verificationUriComplete || login.verificationUri || "";
  const failure =
    login.status === "failed"
      ? t("connect.failed", { error: login.error ?? "" })
      : expired
        ? t("connect.expired")
        : "";
  return (
    <div className="fdy-xacc-form">
      <div className="fdy-xacc-code-copy">
        <strong>{t("connect.codeTitle")}</strong>
        <p>{t("connect.codeBody")}</p>
      </div>
      <div className="fdy-xacc-code" aria-label={t("connect.userCode")}>
        <span>{t("connect.userCode")}</span>
        <code>{login.userCode}</code>
      </div>
      <div className="fdy-xacc-code-actions">
        <Button asChild variant="primary">
          <a href={link} rel="noreferrer" target="_blank">
            <ExternalLink size={14} />
            {t("connect.openPage")}
          </a>
        </Button>
        <Button onClick={() => void copy("code", login.userCode ?? "")}>
          {copied === "code"
            ? t("common:actions.copied")
            : t("connect.copyCode")}
        </Button>
        <Button onClick={() => void copy("link", link)} variant="ghost">
          {copied === "link"
            ? t("common:actions.copied")
            : t("connect.copyLink")}
        </Button>
      </div>
      {failure ? (
        <Alert title={failure} tone="error">
          <Button onClick={onRetry} size="sm">
            {t("connect.tryAgain")}
          </Button>
        </Alert>
      ) : (
        <p className="fdy-xacc-waiting" role="status">
          {t("connect.waiting", { time: countdown(login.expiresAt, now) })}
        </p>
      )}
    </div>
  );
}
