import type { ToastTone } from "../../components/ui/toast";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ExternalAccessLevel,
  ExternalAccount,
  ExternalAccountLogin,
  ExternalAccountsView,
  WorkspaceExternalAccounts,
} from "@bd777/foundry-protocol";
import {
  isNotFoundForCaller,
  beginCloudflareSignIn,
  cancelCloudflareSignIn,
  getExternalAccountLogin,
  getExternalAccounts,
  getCloudflareZones,
  getCloudflareBindingWorkspaces,
  getWorkspaceExternalAccounts,
  setWorkspaceExternalAccounts,
  revokeExternalAccount,
  type CloudflareZone,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/field";
import { Dialog } from "../../components/ui/dialog";
import { SelectMenu } from "../../components/ui/select-menu";
import { ChevronRight } from "lucide-react";
import { navigateToConnectors } from "../../lib/in-app-navigation";
import { errorText } from "./account-format";
import { ConnectorSection } from "./connector-section";
import { CredentialHolding } from "./credential-holding";
import { CloudflareAccountCard } from "./cloudflare-account-card";
import { CloudflareAccessLevels } from "./cloudflare-access";
import { LoadingState } from "../../components/ui/loading";
import { ButtonRow } from "../../components/ui/button-row";
import { CheckLabel } from "../../components/ui/check-label";
import { DividedList } from "../../components/ui/divided-list";
import { FormLayout } from "../../components/ui/form-field";
import { MutedText } from "../../components/ui/text";

interface Props {
  currentUserId: string;
  onNotice: (message: string, tone?: ToastTone) => void;
  workspaceId?: string;
  workspaceView?: WorkspaceExternalAccounts;
  onWorkspaceChanged?: (view: WorkspaceExternalAccounts) => void;
  readOnlyReason?: string;
}
function cloudflarePreset(
  providers: ExternalAccountsView["providers"] | undefined,
): string[] | undefined {
  return providers?.find((p) => p.kind === "cloudflare")?.scopePreset?.scopes;
}
function cloudflareAccessLevels(
  providers: ExternalAccountsView["providers"] | undefined,
): ExternalAccessLevel[] | undefined {
  return providers?.find((p) => p.kind === "cloudflare")?.accessLevels;
}

export function CloudflareConnector(props: Props) {
  const { t } = useTranslation("externalAccounts");
  const [accounts, setAccounts] = useState<ExternalAccount[]>([]);
  const [configured, setConfigured] = useState(true);
  const [requestedScopes, setRequestedScopes] = useState<string[]>();
  const [accessLevels, setAccessLevels] = useState<ExternalAccessLevel[]>();
  const [error, setError] = useState("");
  const [auth, setAuth] = useState<{ accountId?: string }>();
  const [revoking, setRevoking] = useState<ExternalAccount>();
  const [busy, setBusy] = useState(false);
  const [workspaces, setWorkspaces] = useState<
    Array<{ id: string; name: string; detail?: string }>
  >([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState("");
  const [selectedView, setSelectedView] = useState<WorkspaceExternalAccounts>();
  const ws = props.workspaceId ?? selectedWorkspace;
  const view =
    props.workspaceView ??
    (selectedView?.workspaceId === ws ? selectedView : undefined);
  const currentWorkspace = useRef(ws);
  currentWorkspace.current = ws;
  const apply = (v: WorkspaceExternalAccounts) => {
    if (v.workspaceId !== currentWorkspace.current) return;
    if (props.onWorkspaceChanged) props.onWorkspaceChanged(v);
    else setSelectedView(v);
  };
  async function load() {
    try {
      if (props.workspaceId) {
        apply(await getWorkspaceExternalAccounts(props.workspaceId));
        setError("");
        return;
      }
      const next = await getExternalAccounts();
      setRequestedScopes(cloudflarePreset(next.providers));
      setAccessLevels(cloudflareAccessLevels(next.providers));
      setAccounts(
        next.accounts.filter(
          (a) =>
            a.provider === "cloudflare" &&
            a.ownerUserId === props.currentUserId,
        ),
      );
      setConfigured(next.secretsConfigured);
      setError("");
      if (ws) apply(await getWorkspaceExternalAccounts(ws));
    } catch (e) {
      setError(errorText(e));
    }
  }
  useEffect(() => {
    // A workspace's view carries no provider list; read what Foundry asks for.
    if (props.workspaceId)
      void getExternalAccounts()
        .then((next) => {
          setRequestedScopes(cloudflarePreset(next.providers));
          setAccessLevels(cloudflareAccessLevels(next.providers));
        })
        .catch(() => {});
  }, [props.workspaceId]);
  useEffect(() => {
    if (!props.workspaceId) void load();
    if (!props.workspaceId)
      void getCloudflareBindingWorkspaces()
        .then(setWorkspaces)
        .catch((e) => setError(errorText(e)));
  }, [props.currentUserId]);
  useEffect(() => {
    if (!selectedWorkspace) return;
    setSelectedView(undefined);
    void getWorkspaceExternalAccounts(selectedWorkspace)
      .then(setSelectedView)
      .catch((e) => setError(errorText(e)));
  }, [selectedWorkspace]);
  const mine = props.workspaceView
    ? props.workspaceView.accounts.filter(
        (a) =>
          a.provider === "cloudflare" && a.ownerUserId === props.currentUserId,
      )
    : accounts;
  return (
    <ConnectorSection
      actions={
        <>
          <Button
            variant={mine.length ? "secondary" : "primary"}
            size="sm"
            disabled={!configured || Boolean(props.readOnlyReason)}
            onClick={() => setAuth({})}
          >
            {t("cloudflare.connect")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void load()}>
            {t("cloudflare.refresh")}
          </Button>
          {props.workspaceId ? (
            <Button
              onClick={() => navigateToConnectors("cloudflare")}
              size="sm"
              variant="ghost"
            >
              {t("workspace.manage")}
              <ChevronRight size={14} />
            </Button>
          ) : null}
        </>
      }
      description={t("cloudflare.intro")}
      holding={
        props.workspaceId ? (
          <CredentialHolding
            holding="server_held"
            name={t("providers.cloudflare")}
          />
        ) : undefined
      }
      name={t("providers.cloudflare")}
    >
      {error ? (
        <Alert tone="error" title={error}>
          <Button size="sm" onClick={() => void load()}>
            {t("connect.tryAgain")}
          </Button>
        </Alert>
      ) : null}
      {!configured ? (
        <Alert tone="info" title={t("cloudflare.noSecretStore")} />
      ) : null}
      {!mine.length ? (
        <MutedText>{t("cloudflare.empty")}</MutedText>
      ) : (
        <DividedList>
          {mine.map((a) => (
            <CloudflareAccountCard
              key={a.id}
              account={a}
              requestedScopes={requestedScopes}
              onReauthorize={() => setAuth({ accountId: a.id })}
              onRevoke={() => setRevoking(a)}
            />
          ))}
        </DividedList>
      )}
      {mine.length ? (
        <section
          aria-labelledby="fdy-cf-workspace-access"
          className="grid min-w-0 gap-2 border-t border-line pt-3.5"
        >
          <h3
            className="text-md font-semibold text-ink"
            id="fdy-cf-workspace-access"
          >
            {t("cloudflare.workspaceAccess")}
          </h3>
          <MutedText>{t("cloudflare.bindingDetail")}</MutedText>
          {!props.workspaceId ? (
            <SelectMenu
              ariaLabel={t("cloudflare.workspace")}
              value={selectedWorkspace}
              placeholder={t("cloudflare.chooseWorkspace")}
              options={workspaces.map((w) => ({
                value: w.id,
                label: w.name,
                detail: w.detail ?? w.id,
              }))}
              onChange={setSelectedWorkspace}
            />
          ) : null}
          {ws && view ? (
            <CloudflareBinding
              key={`${ws}:${props.currentUserId}`}
              workspaceId={ws}
              view={view}
              accounts={mine}
              accessLevels={accessLevels}
              onChanged={apply}
              disabled={Boolean(props.readOnlyReason)}
              onNotice={props.onNotice}
            />
          ) : null}
        </section>
      ) : null}
      {auth ? (
        <CloudflareAuthorization
          key={auth.accountId ?? "new"}
          accountId={auth.accountId}
          onClose={() => {
            setAuth(undefined);
            void load();
          }}
          onConnected={() => {
            setAuth(undefined);
            void load();
            props.onNotice(t("cloudflare.connected"));
          }}
        />
      ) : null}
      {revoking ? (
        <Dialog
          title={t("cloudflare.revoke")}
          description={t("cloudflare.revokeDetail")}
          onClose={() => setRevoking(undefined)}
          busy={busy}
          footer={
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void revokeExternalAccount(revoking.id)
                  .then(() => {
                    setRevoking(undefined);
                    void load();
                  })
                  .catch(async (e) => {
                    await load();
                    setError(errorText(e));
                  })
                  .finally(() => setBusy(false));
              }}
            >
              {t("cloudflare.revoke")}
            </Button>
          }
        >
          <p>{revoking.displayName || revoking.label}</p>
        </Dialog>
      ) : null}
    </ConnectorSection>
  );
}

function CloudflareAuthorization({
  accountId,
  onClose,
  onConnected,
}: {
  accountId?: string;
  onClose: () => void;
  onConnected: () => void;
}) {
  const { t } = useTranslation("externalAccounts");
  const request = useRef(crypto.randomUUID());
  const operation = useRef("");
  const mounted = useRef(false);
  const finished = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const [login, setLogin] = useState<ExternalAccountLogin>();
  const [unknown, setUnknown] = useState(false);
  const [error, setError] = useState("");
  const completed = useRef(onConnected);
  completed.current = onConnected;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      queueMicrotask(() => {
        if (!mounted.current && !finished.current && operation.current)
          void cancelCloudflareSignIn(operation.current, request.current).catch(
            () => {},
          );
      });
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    const startedRequestId = request.current;
    let timer: ReturnType<typeof setTimeout>;
    setError("");
    setUnknown(false);
    async function step() {
      try {
        const next = operation.current
          ? await getExternalAccountLogin(operation.current)
          : await beginCloudflareSignIn(request.current, accountId);
        if (cancelled) {
          if (!mounted.current)
            void cancelCloudflareSignIn(next.id, startedRequestId).catch(
              () => {},
            );
          return;
        }
        operation.current = next.id;
        setLogin(next);
        if (next.status === "complete" && next.account) {
          finished.current = true;
          completed.current();
          return;
        }
        if (next.status === "pending")
          timer = setTimeout(
            step,
            Math.max(2, next.intervalSeconds ?? 2) * 1000,
          );
      } catch (e) {
        if (!cancelled) {
          const missing = isNotFoundForCaller(e);
          setUnknown(missing);
          setError(missing ? t("cloudflare.unknownOperation") : errorText(e));
        }
      }
    }
    void step();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [accountId, attempt]);
  const failed = login?.status === "failed";
  let link = login?.verificationUriComplete ?? login?.verificationUri ?? "";
  try {
    const u = new URL(link);
    if (u.protocol !== "https:" || u.username || u.password) link = "";
  } catch {
    link = "";
  }
  return (
    <Dialog
      title={t("cloudflare.connect")}
      description={t("cloudflare.authorizeDetail")}
      onClose={onClose}
      layout="compact"
    >
      <FormLayout>
        {error || failed ? (
          <Alert
            tone={error ? "info" : "error"}
            title={error || login?.error || t("cloudflare.needsAuth")}
          >
            <Button
              size="sm"
              onClick={() => {
                if (unknown) {
                  onClose();
                  return;
                }
                if (failed) {
                  operation.current = "";
                  request.current = crypto.randomUUID();
                  setLogin(undefined);
                }
                setAttempt((v) => v + 1);
              }}
            >
              {t(unknown ? "cloudflare.refresh" : "connect.tryAgain")}
            </Button>
          </Alert>
        ) : (
          <>
            <p role="status">
              {t(
                login?.phase === "verifying"
                  ? "cloudflare.verifying"
                  : link
                    ? "cloudflare.waiting"
                    : "cloudflare.preparing",
              )}
            </p>
            {link ? (
              <Button asChild variant="primary">
                <a href={link} target="_blank" rel="noopener noreferrer">
                  {t("cloudflare.openAuthorization")}
                </a>
              </Button>
            ) : null}
            {login?.error ? (
              <Alert tone="info" title={t("cloudflare.verificationPending")} />
            ) : null}
            {login?.requestedScopes?.length ? (
              <small>
                {t("cloudflare.requestedPermissions")}:{" "}
                {login.requestedScopes.join(", ")}
              </small>
            ) : null}
          </>
        )}
      </FormLayout>
    </Dialog>
  );
}

function CloudflareBinding({
  workspaceId,
  view,
  accounts,
  accessLevels,
  onChanged,
  disabled,
  onNotice,
}: {
  workspaceId: string;
  view: WorkspaceExternalAccounts;
  accounts: ExternalAccount[];
  accessLevels?: ExternalAccessLevel[];
  onChanged: (v: WorkspaceExternalAccounts) => void;
  disabled: boolean;
  onNotice: (s: string, tone?: ToastTone) => void;
}) {
  const { t } = useTranslation("externalAccounts");
  const current = view.bindings.find((b) =>
    accounts.some((a) => a.id === b.accountId),
  );
  const [accountId, setAccountId] = useState(
    current?.accountId ?? accounts[0]?.id ?? "",
  );
  const [selected, setSelected] = useState<string[]>(
    current?.resourceIds ?? [],
  );
  const [zones, setZones] = useState<CloudflareZone[]>([]);
  const [page, setPage] = useState(1);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const account = accounts.find((a) => a.id === accountId);
  const unverified = selected.filter((id) => !zones.some((z) => z.id === id));
  const discovery = useRef(0);
  const activeAccount = useRef(accountId);
  activeAccount.current = accountId;
  async function discover(pageNumber = 1) {
    if (!accountId) return;
    const requestVersion = ++discovery.current;
    const requestedAccount = accountId;
    setLoading(true);
    setError("");
    try {
      const result = await getCloudflareZones(accountId, pageNumber);
      if (
        requestVersion !== discovery.current ||
        requestedAccount !== activeAccount.current
      )
        return;
      if (!result.success) throw new Error(t("cloudflare.discoveryFailed"));
      setZones((old) =>
        pageNumber === 1
          ? result.result
          : [
              ...old,
              ...result.result.filter((z) => !old.some((x) => x.id === z.id)),
            ],
      );
      setPage(pageNumber);
      setMore(pageNumber < (result.result_info?.total_pages ?? 1));
    } catch (e) {
      if (
        requestVersion === discovery.current &&
        requestedAccount === activeAccount.current
      )
        setError(errorText(e));
    } finally {
      if (
        requestVersion === discovery.current &&
        requestedAccount === activeAccount.current
      )
        setLoading(false);
    }
  }
  useEffect(() => {
    const binding = view.bindings.find((b) => b.accountId === accountId);
    setSelected(binding?.resourceIds ?? []);
    setZones([]);
    setMore(false);
    void discover();
  }, [accountId]);
  useEffect(() => {
    if (!accountId && accounts[0]) setAccountId(accounts[0].id);
  }, [accounts, accountId]);
  async function save(remove = false) {
    if (!accountId) return;
    setSaving(true);
    setError("");
    try {
      const cfIDs = new Set(accounts.map((a) => a.id));
      const ids = view.bindings
        .filter(
          (b) =>
            !cfIDs.has(b.accountId) &&
            view.accounts.some(
              (a) =>
                a.id === b.accountId && a.ownerUserId === account?.ownerUserId,
            ),
        )
        .map((b) => b.accountId);
      if (!remove) ids.push(accountId);
      const next = await setWorkspaceExternalAccounts(
        workspaceId,
        ids,
        remove ? {} : { [accountId]: selected },
      );
      onChanged(next);
      onNotice(t(remove ? "cloudflare.unbound" : "cloudflare.bound"));
      if (remove) setSelected([]);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }
  return (
    <FormLayout>
      <SelectMenu
        ariaLabel={t("cloudflare.identity")}
        value={accountId}
        disabled={disabled || saving}
        options={accounts.map((a) => ({
          value: a.id,
          label: a.displayName || a.label,
          detail: a.subject,
          disabled: a.status !== "ready" && a.status !== "expiring",
        }))}
        onChange={setAccountId}
        placeholder={t("cloudflare.chooseIdentity")}
      />
      {error ? <Alert tone="error" title={error} /> : null}
      {loading ? <LoadingState label={t("cloudflare.discovering")} /> : null}
      <ul className="grid min-w-0">
        {zones.map((z) => (
          <li key={z.id}>
            <CheckLabel>
              <Checkbox
                checked={selected.includes(z.id)}
                disabled={disabled || saving}
                onChange={(e) => {
                  const checked = e.currentTarget.checked;
                  setSelected((old) =>
                    checked
                      ? Array.from(new Set([...old, z.id]))
                      : old.filter((id) => id !== z.id),
                  );
                }}
              />
              <span className="wrap-anywhere">
                <strong>{z.name}</strong>
                <small>
                  {z.account?.name} · {z.account?.id} · {z.type} · {z.status}
                </small>
              </span>
            </CheckLabel>
          </li>
        ))}
      </ul>
      {!loading && unverified.length ? (
        <ul className="grid min-w-0">
          {unverified.map((id) => (
            <li key={id}>
              <CheckLabel>
                <Checkbox
                  checked
                  disabled={disabled || saving}
                  onChange={() =>
                    setSelected((old) => old.filter((x) => x !== id))
                  }
                />
                <span className="wrap-anywhere">
                  <strong>{id}</strong>
                  <small>{t("cloudflare.unverifiedZone")}</small>
                </span>
              </CheckLabel>
            </li>
          ))}
        </ul>
      ) : null}
      {more ? (
        <Button
          size="sm"
          disabled={loading}
          onClick={() => void discover(page + 1)}
        >
          {t("cloudflare.more")}
        </Button>
      ) : null}
      <ButtonRow align="end">
        <Button
          size="sm"
          variant="primary"
          disabled={
            disabled ||
            saving ||
            loading ||
            !accountId ||
            !selected.length ||
            unverified.length > 0 ||
            (account?.status !== "ready" && account?.status !== "expiring")
          }
          onClick={() => void save()}
        >
          {t("cloudflare.save")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={loading || !accountId}
          onClick={() => void discover()}
        >
          {t("cloudflare.refreshZones")}
        </Button>
        {current ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled || saving}
            onClick={() => void save(true)}
          >
            {t("cloudflare.removeBinding")}
          </Button>
        ) : null}
      </ButtonRow>
      {current && account && current.accountId === accountId ? (
        <CloudflareAccessLevels
          workspaceId={workspaceId}
          binding={current}
          account={account}
          levels={accessLevels}
          disabled={disabled || saving}
          onChanged={onChanged}
          onNotice={onNotice}
        />
      ) : (
        <MutedText>{t("cloudflare.accessAfterSave")}</MutedText>
      )}
      <MutedText>{t("cloudflare.consumption")}</MutedText>
    </FormLayout>
  );
}
