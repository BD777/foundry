import * as Dialog from "@radix-ui/react-dialog";
import { ChevronRight } from "lucide-react";
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
  setupExternalAccount,
} from "../../api";
import { ActionRow } from "../../components/ui/action-row";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { FieldHint, Checkbox, TextInput } from "../../components/ui/field";
import { appName, errorText } from "./account-format";
import {
  PartialGrant,
  ScanStep,
  SignInModal,
  useScopeOptions,
  type SignInBrand,
} from "./sign-in";
import { LoadingState } from "../../components/ui/loading";
import { ButtonRow } from "../../components/ui/button-row";
import { CheckLabel } from "../../components/ui/check-label";
import { FormField, FormLayout } from "../../components/ui/form-field";
import { Disclosure, DisclosureSummary } from "../../components/ui/disclosure";

export interface ConnectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The provider's description: its scope preset and whether it creates apps. */
  provider?: ExternalProvider;
  /** Apps an administrator shared that the person has no account through yet. */
  teamApps: ExternalProviderApp[];
  isAdmin: boolean;
  onAppCreated: (app: ExternalProviderApp) => void;
  onConnected: (account: ExternalAccount) => void;
}

/**
 * Adds a Feishu account, and only that: the QR code of a new app's sign-in
 * opens at once. A team app is a one-scan alternative above it; pasting an
 * own app sits under Advanced. Changing what is connected happens on the
 * page's rows.
 */
export function ConnectDialog(props: ConnectDialogProps) {
  const { t } = useTranslation("externalAccounts");
  return (
    <SignInModal
      description={t("connect.description")}
      onOpenChange={props.onOpenChange}
      open={props.open}
      title={t("connect.title")}
    >
      <ConnectFlow {...props} />
    </SignInModal>
  );
}

/** Where the sign-in goes: a new app created as the person scans, or an app that exists. */
type Route = { kind: "new" } | { kind: "app"; appId: string };

function ConnectFlow({
  provider,
  teamApps,
  isAdmin,
  onAppCreated,
  onConnected,
  onOpenChange,
}: ConnectDialogProps) {
  const { t } = useTranslation("externalAccounts");
  const registers = Boolean(provider?.registersApps);
  const scope = useScopeOptions(provider);
  // Without a way to create an app and with no team app, pasting one is
  // the only path, so it starts chosen and open.
  const pasteOnly = !registers && teamApps.length === 0;
  const [ownApp, setOwnApp] = useState(pasteOnly);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [shared, setShared] = useState(false);
  const [label, setLabel] = useState("");
  const [route, setRoute] = useState<Route>();
  const [brand, setBrand] = useState<SignInBrand>("feishu");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [login, setLogin] = useState<ExternalAccountLogin>();
  const [finished, setFinished] = useState<ExternalAccountLogin>();
  // Only the latest start shows: an earlier answer arriving late is dropped.
  const attempt = useRef(0);

  const extra = {
    ...(label.trim() ? { label: label.trim() } : {}),
    ...scope.extra,
  };

  function request(next: Route, signIn: SignInBrand) {
    return next.kind === "new"
      ? setupExternalAccount({
          provider: "feishu",
          ...(signIn === "lark" ? { brand: "lark" } : {}),
          ...extra,
        })
      : connectExternalAccount({ appId: next.appId, ...extra });
  }

  async function begin(next: Route, signIn = brand) {
    const mine = ++attempt.current;
    setBusy(true);
    setError("");
    setRoute(next);
    setLogin(undefined);
    try {
      const started = await request(next, signIn);
      if (mine !== attempt.current) return;
      setBrand(signIn);
      setLogin(started);
    } catch (cause) {
      if (mine === attempt.current) setError(errorText(cause));
    } finally {
      if (mine === attempt.current) setBusy(false);
    }
  }

  /** Restarts the new-app registration on the other brand's login page. */
  async function switchBrand(signIn: SignInBrand) {
    const mine = ++attempt.current;
    const next = await request({ kind: "new" }, signIn);
    if (mine !== attempt.current) return;
    setBrand(signIn);
    setLogin(next);
  }

  useEffect(() => {
    if (registers) void begin({ kind: "new" });
  }, []);

  async function applyAdvanced(event: FormEvent) {
    event.preventDefault();
    if (!ownApp) {
      if (route) void begin(route);
      return;
    }
    if (!clientId.trim()) return setError(t("connect.appIdRequired"));
    if (!clientSecret.trim()) return setError(t("connect.appSecretRequired"));
    setBusy(true);
    setError("");
    try {
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
      await begin({ kind: "app", appId: app.id });
    } catch (cause) {
      setError(errorText(cause));
      setBusy(false);
    }
  }

  if (finished) return <PartialGrant login={finished} onClose={onOpenChange} />;

  const onTeamApp =
    route?.kind === "app" && teamApps.some((app) => app.id === route.appId);
  return (
    <FormLayout>
      {teamApps.length && !onTeamApp ? (
        <div className="grid min-w-0 rounded-lg border border-line-soft p-[3px]">
          {teamApps.map((app) => (
            <ActionRow
              className="fdy-xacc-team-app mb-0 justify-between gap-3 disabled:cursor-default disabled:opacity-60 [&>span]:grid [&>span]:min-w-0 [&>span]:gap-0.5 [&>svg]:text-ink-muted [&_small]:text-xs [&_small]:text-ink-muted [&_strong]:font-semibold [&_strong]:text-sm [&_strong]:text-ink"
              density="compact"
              disabled={busy}
              key={app.id}
              onClick={() => void begin({ kind: "app", appId: app.id })}
            >
              <span>
                <strong>{t("connect.teamApp", { name: appName(app) })}</strong>
                <small>{t("connect.teamAppMeta")}</small>
              </span>
              <ChevronRight aria-hidden size={16} />
            </ActionRow>
          ))}
        </div>
      ) : null}
      {onTeamApp && registers ? (
        <Button
          className="justify-self-start"
          disabled={busy}
          onClick={() => void begin({ kind: "new" })}
          size="inline"
          variant="link"
        >
          {t("connect.newAppInstead")}
        </Button>
      ) : null}
      {error ? (
        <Alert title={t("connect.failed", { error })} tone="error">
          {route ? (
            <Button onClick={() => void begin(route)} size="sm">
              {t("connect.tryAgain")}
            </Button>
          ) : null}
        </Alert>
      ) : null}
      {login ? (
        <ScanStep
          key={login.id}
          brand={route?.kind === "new" ? brand : undefined}
          login={login}
          onSwitchBrand={switchBrand}
          onAppCreated={onAppCreated}
          onDone={(done) => {
            if (done.account) onConnected(done.account);
            if (done.missingScopes?.length) setFinished(done);
            else onOpenChange(false);
          }}
          onRetry={(appId) =>
            // A setup that already created its app retries through it.
            void begin(
              appId ? { kind: "app", appId } : (route ?? { kind: "new" }),
            )
          }
        />
      ) : busy && route ? (
        <LoadingState
          className="text-xs leading-[1.45] text-ink-muted"
          label={t("connect.starting")}
        />
      ) : null}
      {scope.summary}
      <Disclosure className="fdy-xacc-advanced" open={pasteOnly || undefined}>
        <DisclosureSummary>{t("connect.advanced")}</DisclosureSummary>
        <FormLayout
          as="form"
          className="pt-1"
          onSubmit={(event) => void applyAdvanced(event)}
        >
          {scope.fields}
          <FormField className="fdy-xacc-field">
            <span>{t("connect.nameLabel")}</span>
            <TextInput
              onChange={(event) => setLabel(event.target.value)}
              placeholder={t("connect.namePlaceholder")}
              tone="boxed"
              value={label}
            />
          </FormField>
          {pasteOnly ? null : (
            <CheckLabel>
              <Checkbox
                checked={ownApp}
                onChange={(event) => setOwnApp(event.currentTarget.checked)}
              />
              <span>
                {t("connect.ownApp")}
                <small>{t("connect.ownAppMeta")}</small>
              </span>
            </CheckLabel>
          )}
          {ownApp ? (
            <>
              <FormField className="fdy-xacc-field">
                <span>{t("connect.appIdLabel")}</span>
                <TextInput
                  autoComplete="off"
                  onChange={(event) => setClientId(event.target.value)}
                  placeholder={t("connect.appIdPlaceholder")}
                  tone="boxed"
                  value={clientId}
                />
              </FormField>
              <FormField className="fdy-xacc-field">
                <span>{t("connect.appSecretLabel")}</span>
                <TextInput
                  autoComplete="new-password"
                  onChange={(event) => setClientSecret(event.target.value)}
                  tone="boxed"
                  type="password"
                  value={clientSecret}
                />
                <FieldHint as="small" className="text-ink-faint">
                  {t("connect.appSecretHint")}
                </FieldHint>
              </FormField>
              <FormField className="fdy-xacc-field">
                <span>{t("connect.baseUrlLabel")}</span>
                <TextInput
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder={t("connect.baseUrlPlaceholder")}
                  tone="boxed"
                  value={baseUrl}
                />
                <FieldHint as="small" className="text-ink-faint">
                  {t("connect.baseUrlHint")}
                </FieldHint>
              </FormField>
              {isAdmin ? (
                <CheckLabel>
                  <Checkbox
                    checked={shared}
                    onChange={(event) => setShared(event.currentTarget.checked)}
                  />
                  <span>
                    {t("connect.shareLabel")}
                    <FieldHint as="small">{t("connect.shareHint")}</FieldHint>
                  </span>
                </CheckLabel>
              ) : null}
            </>
          ) : null}
          {ownApp || route ? (
            <ButtonRow align="end" as="span">
              <Button disabled={busy} type="submit">
                {ownApp ? t("connect.start") : t("connect.restart")}
              </Button>
            </ButtonRow>
          ) : null}
        </FormLayout>
      </Disclosure>
      <ButtonRow align="end">
        <Dialog.Close asChild>
          <Button variant="ghost">{t("connect.cancel")}</Button>
        </Dialog.Close>
      </ButtonRow>
    </FormLayout>
  );
}
