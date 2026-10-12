import * as Dialog from "@radix-ui/react-dialog";
import { ExternalLink, X } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type {
  ExternalAccount,
  ExternalAccountLogin,
  ExternalProvider,
  ExternalProviderApp,
} from "@bd777/foundry-protocol";
import {
  connectExternalAccount,
  createExternalApp,
  getExternalAccountLogin,
  setupExternalAccount,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Checkbox, TextInput } from "../../components/ui/field";
import { SelectMenu } from "../../components/ui/select-menu";
import { accountName, countdown, errorText } from "./account-format";

/** Choices that create a new app at the provider while signing in. */
const newFeishuApp = "new:feishu";
const newLarkApp = "new:lark";

export interface ConnectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  apps: ExternalProviderApp[];
  /** The provider's description: its scope preset and whether it creates apps. */
  provider?: ExternalProvider;
  /** The app to sign in through again (a reconnect). */
  initialAppId?: string;
  isAdmin: boolean;
  onAppCreated: (app: ExternalProviderApp) => void;
  onConnected: (account: ExternalAccount) => void;
}

export function ConnectDialog(props: ConnectDialogProps) {
  const { t } = useTranslation("externalAccounts");
  // Opened by a button, not a Dialog.Trigger, so Radix knows no element to
  // return focus to: closing returns it to the one focused as it opened.
  const opener = useRef<HTMLElement | null>(null);
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fdy-xacc-modal-overlay" />
        <Dialog.Content
          className="fdy-xacc-modal"
          onOpenAutoFocus={() => {
            opener.current =
              document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            opener.current?.focus();
            opener.current = null;
          }}
        >
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

/** An organization app first: signing in through it needs one scan only. */
function preferredApp(apps: ExternalProviderApp[]) {
  return apps.find((app) => app.visibility === "instance") ?? apps[0];
}

function ConnectFlow({
  apps,
  provider,
  initialAppId,
  isAdmin,
  onAppCreated,
  onConnected,
  onOpenChange,
}: ConnectDialogProps) {
  const { t } = useTranslation("externalAccounts");
  const registers = Boolean(provider?.registersApps);
  const [choice, setChoice] = useState(
    initialAppId ?? preferredApp(apps)?.id ?? (registers ? newFeishuApp : ""),
  );
  // Without a way to create an app and with none to use, pasting one is
  // the only path, so it starts open.
  const [ownApp, setOwnApp] = useState(!registers && apps.length === 0);
  const [advancedOpen] = useState(ownApp);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [shared, setShared] = useState(false);
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState("");
  const [approval, setApproval] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [login, setLogin] = useState<ExternalAccountLogin>();
  const [finished, setFinished] = useState<ExternalAccountLogin>();

  const preset = provider?.scopePreset;
  const named = scopes.split(/[\s,]+/).filter(Boolean);
  const always = provider?.alwaysScopes ?? [];
  const asked = named.length
    ? named.length + always.length
    : (preset?.scopes.length ?? 0) +
      always.length +
      (approval ? (preset?.approvalScopes?.length ?? 0) : 0);

  async function start(event: FormEvent) {
    event.preventDefault();
    if (ownApp && !clientId.trim()) return setError(t("connect.appIdRequired"));
    if (ownApp && !clientSecret.trim())
      return setError(t("connect.appSecretRequired"));
    setBusy(true);
    setError("");
    const extra = {
      ...(label.trim() ? { label: label.trim() } : {}),
      ...(named.length ? { scopes: named } : {}),
      ...(approval ? { includeApprovalScopes: true } : {}),
    };
    try {
      if (!ownApp && (choice === newFeishuApp || choice === newLarkApp)) {
        setLogin(
          await setupExternalAccount({
            provider: "feishu",
            ...(choice === newLarkApp ? { brand: "lark" } : {}),
            ...extra,
          }),
        );
        return;
      }
      let appId = choice;
      if (ownApp) {
        const app = await createExternalApp({
          provider: "feishu",
          label: "",
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim(),
          baseUrl: baseUrl.trim() || undefined,
          visibility: shared ? "instance" : "personal",
        });
        setClientSecret("");
        setOwnApp(false);
        onAppCreated(app);
        setChoice(app.id);
        appId = app.id;
      }
      setLogin(await connectExternalAccount({ appId, ...extra }));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  if (finished) return <PartialGrant login={finished} onClose={onOpenChange} />;

  if (login)
    return (
      <ScanStep
        login={login}
        onAppCreated={onAppCreated}
        onDone={(done) => {
          if (done.account) onConnected(done.account);
          if (done.missingScopes?.length) setFinished(done);
          else onOpenChange(false);
        }}
        onRetry={(appId) => {
          // A setup that already created its app retries through it.
          if (appId) setChoice(appId);
          setLogin(undefined);
        }}
      />
    );

  const appOptions = [
    ...(registers
      ? [
          {
            value: newFeishuApp,
            label: t("connect.newFeishuApp"),
            meta: t("connect.newAppMeta"),
          },
          {
            value: newLarkApp,
            label: t("connect.newLarkApp"),
            meta: t("connect.newAppMeta"),
          },
        ]
      : []),
    ...apps.map((app) => ({
      value: app.id,
      label: app.label,
      meta: `${app.visibility === "instance" ? t("apps.instance") : t("apps.personal")} · ${app.clientId}`,
    })),
  ];
  return (
    <form className="fdy-xacc-form" onSubmit={(event) => void start(event)}>
      {error ? (
        <Alert title={t("connect.failed", { error })} tone="error" />
      ) : null}
      {appOptions.length && !ownApp ? (
        <div className="fdy-xacc-field">
          <span>{t("connect.appLabel")}</span>
          <SelectMenu
            ariaLabel={t("connect.appLabel")}
            insideDialog
            onChange={setChoice}
            options={appOptions}
            value={choice}
          />
          <small>
            {choice === newFeishuApp || choice === newLarkApp
              ? t("connect.newAppHint")
              : t("connect.existingAppHint")}
          </small>
        </div>
      ) : null}
      {preset ? (
        <details className="fdy-xacc-scopes">
          <summary>
            {named.length
              ? t("connect.scopesNamed", { count: asked })
              : t("connect.scopesPreset", { count: asked })}
          </summary>
          <p>{t("connect.scopesSource", { source: preset.source })}</p>
          <code>
            {(named.length
              ? named
              : [
                  ...preset.scopes,
                  ...(approval ? (preset.approvalScopes ?? []) : []),
                ]
            )
              .concat(always)
              .join(" ")}
          </code>
        </details>
      ) : null}
      <details className="fdy-xacc-advanced" open={advancedOpen || undefined}>
        <summary>{t("connect.advanced")}</summary>
        <div className="fdy-xacc-form">
          {preset?.approvalScopes?.length ? (
            <label className="fdy-xacc-check">
              <Checkbox
                checked={approval}
                onChange={(event) => setApproval(event.currentTarget.checked)}
              />
              <span>
                {t("connect.approvalLabel", {
                  count: preset.approvalScopes.length,
                })}
                <small>
                  {t("connect.approvalHint", {
                    scopes: preset.approvalScopes.join(", "),
                  })}
                </small>
              </span>
            </label>
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
          <label className="fdy-xacc-check">
            <Checkbox
              checked={ownApp}
              onChange={(event) => setOwnApp(event.currentTarget.checked)}
            />
            <span>
              {t("connect.ownApp")}
              <small>{t("connect.ownAppMeta")}</small>
            </span>
          </label>
          {ownApp ? (
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
        </div>
      </details>
      <div className="fdy-xacc-form-actions">
        <Dialog.Close asChild>
          <Button disabled={busy} variant="ghost">
            {t("connect.cancel")}
          </Button>
        </Dialog.Close>
        <Button
          disabled={busy || (!ownApp && !choice)}
          type="submit"
          variant="primary"
        >
          {busy ? t("connect.starting") : t("connect.start")}
        </Button>
      </div>
    </form>
  );
}

/**
 * The QR code and link of the current step, polled until the sign-in
 * completes, fails or expires. A setup moves from confirming the new app to
 * authorizing it under the same login; the code changes with the step.
 */
function ScanStep({
  login: started,
  onAppCreated,
  onDone,
  onRetry,
}: {
  login: ExternalAccountLogin;
  onAppCreated: (app: ExternalProviderApp) => void;
  onDone: (login: ExternalAccountLogin) => void;
  onRetry: (appId?: string) => void;
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
    let announcedApp = "";
    const tick = async () => {
      let current = started;
      while (!cancelled) {
        const interval = Math.max(2, current.intervalSeconds ?? 0) * 1000;
        await new Promise((settle) => setTimeout(settle, interval));
        if (cancelled) return;
        try {
          const next = await getExternalAccountLogin(started.id);
          if (cancelled) return;
          current = { ...current, ...next };
          setLogin(current);
          if (next.app && next.app.id !== announcedApp) {
            announcedApp = next.app.id;
            onAppCreated(next.app);
          }
          if (next.status === "complete" && next.account) return onDone(next);
          if (next.status !== "pending") return;
        } catch (cause) {
          if (cancelled) return;
          setLogin((previous) => ({
            ...previous,
            status: "failed",
            error: errorText(cause),
          }));
          return;
        }
        if (
          current.expiresAt &&
          Date.now() > Date.parse(current.expiresAt) + 30_000
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

  useEffect(() => setCopied(""), [login.phase]);

  async function copy(kind: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
    } catch {
      setCopied("");
    }
  }

  const link = login.verificationUriComplete || login.verificationUri || "";
  const step =
    login.phase === "register"
      ? "register"
      : login.phase === "authorize"
        ? "authorize"
        : "login";
  const failure =
    login.status === "failed"
      ? t("connect.failed", { error: login.error ?? "" })
      : expired
        ? t("connect.expired")
        : "";
  return (
    <div className="fdy-xacc-form">
      <div className="fdy-xacc-scan">
        <div className="fdy-xacc-qr" data-dimmed={failure ? "true" : undefined}>
          <QRCodeSVG
            bgColor="#ffffff"
            fgColor="#111111"
            level="M"
            marginSize={2}
            size={176}
            title={t("connect.qrTitle")}
            value={link}
          />
        </div>
        <div className="fdy-xacc-code-copy">
          {step !== "login" ? (
            <span className="fdy-xacc-step">
              {t("connect.stepOf", { step: step === "register" ? 1 : 2 })}
            </span>
          ) : null}
          <strong>{t(`connect.${step}Title`)}</strong>
          <p>{t(`connect.${step}Body`)}</p>
          <div className="fdy-xacc-code-actions">
            <Button asChild size="sm" variant="primary">
              <a href={link} rel="noreferrer" target="_blank">
                <ExternalLink size={14} />
                {t("connect.openPage")}
              </a>
            </Button>
            <Button
              onClick={() => void copy("link", link)}
              size="sm"
              variant="ghost"
            >
              {copied === "link"
                ? t("common:actions.copied")
                : t("connect.copyLink")}
            </Button>
          </div>
          {login.userCode ? (
            <small className="fdy-xacc-user-code">
              {t("connect.userCode")} <code>{login.userCode}</code>
            </small>
          ) : null}
        </div>
      </div>
      {failure ? (
        <Alert title={failure} tone="error">
          <Button onClick={() => onRetry(login.app?.id)} size="sm">
            {t("connect.tryAgain")}
          </Button>
        </Alert>
      ) : (
        <p className="fdy-xacc-waiting" role="status">
          {t(step === "register" ? "connect.waitingApp" : "connect.waiting", {
            time: countdown(login.expiresAt, now),
          })}
        </p>
      )}
    </div>
  );
}

/** Connected, but the provider granted less than asked: say what is missing and where to enable it. */
function PartialGrant({
  login,
  onClose,
}: {
  login: ExternalAccountLogin;
  onClose: (open: boolean) => void;
}) {
  const { t } = useTranslation("externalAccounts");
  const missing = login.missingScopes ?? [];
  const requested = login.requestedScopes?.length ?? 0;
  return (
    <div className="fdy-xacc-form">
      <Alert
        title={t("connect.partialTitle", {
          name: login.account ? accountName(login.account) : "",
          granted: Math.max(0, requested - missing.length),
          requested,
        })}
        tone="warning"
      >
        <p>{t("connect.partialBody", { count: missing.length })}</p>
      </Alert>
      <details className="fdy-xacc-scopes">
        <summary>{t("connect.missingList", { count: missing.length })}</summary>
        <code>{missing.join(" ")}</code>
      </details>
      <div className="fdy-xacc-form-actions">
        {login.scopeApplyUrl ? (
          <Button asChild variant="ghost">
            <a href={login.scopeApplyUrl} rel="noreferrer" target="_blank">
              <ExternalLink size={14} />
              {t("connect.applyScopes")}
            </a>
          </Button>
        ) : null}
        <Button onClick={() => onClose(false)} variant="primary">
          {t("connect.done")}
        </Button>
      </div>
    </div>
  );
}
