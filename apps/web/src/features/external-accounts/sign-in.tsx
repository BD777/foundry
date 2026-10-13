import * as Dialog from "@radix-ui/react-dialog";
import { ExternalLink, X } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type {
  ExternalAccountLogin,
  ExternalProvider,
  ExternalProviderApp,
} from "@bd777/foundry-protocol";
import { getExternalAccountLogin } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Checkbox, TextInput } from "../../components/ui/field";
import { accountName, countdown, errorText } from "./account-format";

/** Which login page a new app's QR code opens; the tenant's brand is detected after the scan. */
export type SignInBrand = "feishu" | "lark";

/** What a sign-in asks for beyond its app: a name and the permissions. */
export interface SignInExtra {
  label?: string;
  scopes?: string[];
  includeApprovalScopes?: boolean;
}

/**
 * The modal every Feishu sign-in opens in. Opened by a button, not a
 * Dialog.Trigger, so Radix knows no element to return focus to: closing
 * returns it to the one focused as it opened.
 */
export function SignInModal({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
}) {
  const { t } = useTranslation("externalAccounts");
  const opener = useRef<HTMLElement | null>(null);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
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
              <Dialog.Title>{title}</Dialog.Title>
              <Dialog.Description>{description}</Dialog.Description>
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
          {open ? children : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * The permissions a sign-in asks for: a summary of the provider's preset,
 * and (for an "Advanced" disclosure) the opt-in approval scopes and a list
 * that replaces the preset. `extra` is what to send with the sign-in.
 */
export function useScopeOptions(provider?: ExternalProvider) {
  const { t } = useTranslation("externalAccounts");
  const [scopes, setScopes] = useState("");
  const [approval, setApproval] = useState(false);
  const preset = provider?.scopePreset;
  const named = scopes.split(/[\s,]+/).filter(Boolean);
  const always = provider?.alwaysScopes ?? [];
  const asked = named.length
    ? named.length + always.length
    : (preset?.scopes.length ?? 0) +
      always.length +
      (approval ? (preset?.approvalScopes?.length ?? 0) : 0);
  const extra: SignInExtra = {
    ...(named.length ? { scopes: named } : {}),
    ...(approval ? { includeApprovalScopes: true } : {}),
  };

  const summary = preset ? (
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
  ) : null;

  const fields = (
    <>
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
    </>
  );
  return { extra, summary, fields };
}

/**
 * The QR code and link of the current step, polled until the sign-in
 * completes, fails or expires. A setup moves from confirming the new app to
 * authorizing it under the same login; the code changes with the step.
 */
export function ScanStep({
  brand,
  login: started,
  onAppCreated,
  onDone,
  onRetry,
  onSwitchBrand,
}: {
  /** The login page a new app's registration opened; unset for other sign-ins. */
  brand?: SignInBrand;
  login: ExternalAccountLogin;
  /** Restarts a new app's registration on the other brand; given with `brand`. */
  onSwitchBrand?: (brand: SignInBrand) => Promise<void>;
  onAppCreated: (app: ExternalProviderApp) => void;
  onDone: (login: ExternalAccountLogin) => void;
  onRetry: (appId?: string) => void;
}) {
  const { t } = useTranslation(["externalAccounts", "common"]);
  const [login, setLogin] = useState(started);
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState("");
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState("");
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

  async function switchBrand(next: SignInBrand) {
    setSwitching(true);
    setSwitchError("");
    try {
      await onSwitchBrand?.(next);
    } catch (cause) {
      setSwitchError(errorText(cause));
      setSwitching(false);
    }
  }

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
          {brand && onSwitchBrand && step === "register" && !failure ? (
            <div className="fdy-xacc-brand-switch">
              <Button
                disabled={switching}
                onClick={() =>
                  void switchBrand(brand === "lark" ? "feishu" : "lark")
                }
                size="inline"
                variant="link"
              >
                {t(
                  brand === "lark"
                    ? "connect.switchToFeishu"
                    : "connect.switchToLark",
                )}
              </Button>
              <small>{t("connect.brandHint")}</small>
            </div>
          ) : null}
        </div>
      </div>
      {switchError ? (
        <Alert
          title={t("connect.failed", { error: switchError })}
          tone="error"
        />
      ) : null}
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
export function PartialGrant({
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
