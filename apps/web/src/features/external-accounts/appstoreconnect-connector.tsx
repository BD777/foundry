import type { ToastTone } from "../../components/ui/toast";
import type {
  AppStoreConnectApp,
  AppStoreConnectConnection,
  ExternalAccessLevel,
  ExternalAccountsView,
  WorkspaceExternalAccounts,
} from "@bd777/foundry-protocol";
import { ChevronRight, KeyRound, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  getAppStoreConnectApps,
  getAppStoreConnectKeys,
  getConnectorBindingWorkspaces,
  getExternalAccounts,
  getWorkspaceExternalAccounts,
  revokeAppStoreConnectKey,
  setWorkspaceAccountAccess,
  setWorkspaceExternalAccounts,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ButtonRow } from "../../components/ui/button-row";
import { Checkbox } from "../../components/ui/field";
import { Dialog } from "../../components/ui/dialog";
import { Skeleton } from "../../components/ui/loading";
import { SelectMenu } from "../../components/ui/select-menu";
import { MutedText } from "../../components/ui/text";
import { navigateToConnectors } from "../../lib/in-app-navigation";
import {
  accountUsable,
  errorText,
  statusLabel,
  statusTone,
} from "./account-format";
import { AppStoreConnectAccessLevels } from "./appstoreconnect-access";
import { AppStoreConnectAccountCard } from "./appstoreconnect-account-card";
import { AppStoreConnectKeyDialog } from "./appstoreconnect-key-dialog";
import { CheckLabel } from "../../components/ui/check-label";
import { ConnectorSection } from "./connector-section";
import { CredentialHolding } from "./credential-holding";
import { DividedList } from "../../components/ui/divided-list";
import { FormLayout } from "../../components/ui/form-field";

interface Props {
  currentUserId: string;
  onNotice: (message: string, tone?: ToastTone) => void;
  workspaceId?: string;
  workspaceView?: WorkspaceExternalAccounts;
  onWorkspaceChanged?: (view: WorkspaceExternalAccounts) => void;
  readOnlyReason?: string;
}

interface AppsState {
  apps?: AppStoreConnectApp[];
  busy?: boolean;
  error?: string;
}

const fallbackLevels: ExternalAccessLevel[] = [
  { name: "read" },
  { name: "commerce" },
];

function appStoreConnectLevels(
  providers: ExternalAccountsView["providers"] | undefined,
): ExternalAccessLevel[] {
  return (
    providers?.find((provider) => provider.kind === "appstoreconnect")
      ?.accessLevels ?? fallbackLevels
  );
}

export function AppStoreConnectConnector(props: Props) {
  const { t } = useTranslation(["externalAccounts", "common"]);
  const [keys, setKeys] = useState<AppStoreConnectConnection[]>([]);
  const [configured, setConfigured] = useState(true);
  const [accessLevels, setAccessLevels] =
    useState<ExternalAccessLevel[]>(fallbackLevels);
  const [apps, setApps] = useState<Record<string, AppsState>>({});
  const [error, setError] = useState("");
  const [editor, setEditor] = useState<{
    connection?: AppStoreConnectConnection;
  }>();
  const [revoking, setRevoking] = useState<AppStoreConnectConnection>();
  const [deleting, setDeleting] = useState(false);
  const [validated, setValidated] = useState<{
    connection: AppStoreConnectConnection;
    apps: AppStoreConnectApp[];
  }>();
  const [workspaces, setWorkspaces] = useState<
    Array<{ id: string; name: string; detail?: string }>
  >([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState("");
  const [selectedView, setSelectedView] = useState<WorkspaceExternalAccounts>();
  const workspaceId = props.workspaceId ?? selectedWorkspace;
  const view =
    props.workspaceView ??
    (selectedView?.workspaceId === workspaceId ? selectedView : undefined);
  const activeWorkspace = useRef(workspaceId);
  activeWorkspace.current = workspaceId;

  const applyWorkspace = (next: WorkspaceExternalAccounts) => {
    if (next.workspaceId !== activeWorkspace.current) return;
    if (props.onWorkspaceChanged) props.onWorkspaceChanged(next);
    else setSelectedView(next);
  };

  async function refreshKeys() {
    const next = await getAppStoreConnectKeys();
    setKeys(next.keys);
    return next.keys;
  }

  async function refreshApps(
    connection: AppStoreConnectConnection,
  ): Promise<AppStoreConnectApp[] | undefined> {
    if (!connection.accountId || !connection.hasKey) return undefined;
    setApps((current) => ({
      ...current,
      [connection.accountId]: {
        ...current[connection.accountId],
        busy: true,
        error: "",
      },
    }));
    try {
      const result = await getAppStoreConnectApps(connection.accountId);
      setApps((current) => ({
        ...current,
        [connection.accountId]: { apps: result.apps, busy: false },
      }));
      return result.apps;
    } catch (cause) {
      setApps((current) => ({
        ...current,
        [connection.accountId]: {
          ...current[connection.accountId],
          busy: false,
          error: errorText(cause),
        },
      }));
      return undefined;
    }
  }

  async function load() {
    try {
      const [keyResult, external] = await Promise.all([
        getAppStoreConnectKeys(),
        getExternalAccounts(),
      ]);
      setKeys(keyResult.keys);
      setConfigured(external.secretsConfigured);
      setAccessLevels(appStoreConnectLevels(external.providers));
      setError("");
      for (const connection of keyResult.keys)
        if (
          connection.hasKey &&
          connection.status !== "revoked" &&
          connection.accountId
        )
          void refreshApps(connection);
      if (!props.workspaceId && workspaceId)
        applyWorkspace(await getWorkspaceExternalAccounts(workspaceId));
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  useEffect(() => {
    void load();
    if (!props.workspaceId)
      void getConnectorBindingWorkspaces()
        .then(setWorkspaces)
        .catch((cause) => setError(errorText(cause)));
  }, [props.currentUserId]);

  useEffect(() => {
    if (!selectedWorkspace) return;
    setSelectedView(undefined);
    void getWorkspaceExternalAccounts(selectedWorkspace)
      .then(setSelectedView)
      .catch((cause) => setError(errorText(cause)));
  }, [selectedWorkspace]);

  const canManage = !props.workspaceId;

  async function saved(connection: AppStoreConnectConnection) {
    setEditor(undefined);
    setValidated(undefined);
    await refreshKeys();
    const visible = await refreshApps(connection);
    setValidated({ connection, apps: visible ?? [] });
    if (workspaceId)
      applyWorkspace(await getWorkspaceExternalAccounts(workspaceId));
    props.onNotice(
      t(
        connection.status === "revoked"
          ? "appstoreconnect.revokedNotice"
          : "appstoreconnect.savedNotice",
        { name: connection.label },
      ),
    );
  }

  async function revoke() {
    if (!revoking) return;
    setDeleting(true);
    setError("");
    try {
      const connection = await revokeAppStoreConnectKey(revoking.appId);
      setRevoking(undefined);
      setValidated(undefined);
      await refreshKeys();
      if (connection.accountId)
        setApps((current) => {
          const next = { ...current };
          delete next[connection.accountId];
          return next;
        });
      if (workspaceId)
        applyWorkspace(await getWorkspaceExternalAccounts(workspaceId));
      props.onNotice(
        t("appstoreconnect.revokedNotice", { name: connection.label }),
      );
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <ConnectorSection
      actions={
        canManage ? (
          <>
            <Button
              disabled={!configured}
              onClick={() => setEditor({})}
              size="sm"
              variant={keys.length ? "secondary" : "primary"}
            >
              <KeyRound aria-hidden="true" size={14} />
              {t("appstoreconnect.addKey")}
            </Button>
            <Button
              busy={apps && Object.values(apps).some((entry) => entry.busy)}
              onClick={() => void load()}
              size="sm"
              variant="ghost"
            >
              <RefreshCw aria-hidden="true" size={13} />
              {t("appstoreconnect.refresh")}
            </Button>
          </>
        ) : (
          <Button
            onClick={() => navigateToConnectors("appstoreconnect")}
            size="sm"
            variant="ghost"
          >
            {t("workspace.manage")}
            <ChevronRight size={14} />
          </Button>
        )
      }
      description={t("appstoreconnect.intro")}
      holding={
        props.workspaceId ? (
          <CredentialHolding
            holding="server_held"
            name={t("providers.appstoreconnect")}
          />
        ) : undefined
      }
      name={t("providers.appstoreconnect")}
    >
      <Alert title={t("appstoreconnect.teamKeyTitle")} tone="info">
        {t("appstoreconnect.teamKeyBody")}
      </Alert>
      {!configured ? (
        <Alert tone="info" title={t("appstoreconnect.noSecretStore")} />
      ) : null}
      {error ? (
        <Alert
          actions={
            <Button onClick={() => void load()} size="sm">
              {t("connect.tryAgain")}
            </Button>
          }
          title={t("appstoreconnect.loadFailed", { error })}
          tone="error"
        />
      ) : null}
      {validated ? (
        <Alert
          title={t("appstoreconnect.validatedTitle", {
            count: validated.apps.length,
          })}
          tone="success"
        >
          {validated.apps.length
            ? t("appstoreconnect.validatedApps", {
                apps: validated.apps
                  .map((app) => app.name || app.id)
                  .join(", "),
              })
            : t("appstoreconnect.validatedNoApps")}
        </Alert>
      ) : null}
      {!keys.length ? (
        <MutedText>{t("appstoreconnect.empty")}</MutedText>
      ) : (
        <DividedList>
          {keys.map((connection) => (
            <AppStoreConnectAccountCard
              apps={
                connection.accountId
                  ? apps[connection.accountId]?.apps
                  : undefined
              }
              appsBusy={Boolean(
                connection.accountId && apps[connection.accountId]?.busy,
              )}
              appsError={
                connection.accountId
                  ? apps[connection.accountId]?.error
                  : undefined
              }
              connection={connection}
              key={connection.appId}
              manage={canManage}
              onRefreshApps={() => void refreshApps(connection)}
              onReplace={() => setEditor({ connection })}
              onRevoke={() => setRevoking(connection)}
            />
          ))}
        </DividedList>
      )}
      {keys.length ? (
        <section
          aria-labelledby="fdy-asc-workspace-access"
          className="grid min-w-0 gap-2 border-t border-line pt-3.5"
        >
          <h3
            className="text-md font-semibold text-ink"
            id="fdy-asc-workspace-access"
          >
            {t("appstoreconnect.workspaceAccess")}
          </h3>
          <MutedText>{t("appstoreconnect.bindingDetail")}</MutedText>
          {!props.workspaceId ? (
            <SelectMenu
              ariaLabel={t("appstoreconnect.workspace")}
              onChange={setSelectedWorkspace}
              options={workspaces.map((workspace) => ({
                detail: workspace.detail ?? workspace.id,
                label: workspace.name,
                value: workspace.id,
              }))}
              placeholder={t("appstoreconnect.chooseWorkspace")}
              value={selectedWorkspace}
            />
          ) : null}
          {workspaceId && view ? (
            <AppStoreConnectBinding
              accessLevels={accessLevels}
              apps={apps}
              connections={keys}
              currentUserId={props.currentUserId}
              disabled={Boolean(props.readOnlyReason)}
              key={`${workspaceId}:${props.currentUserId}`}
              onChanged={applyWorkspace}
              onNotice={props.onNotice}
              onRefreshApps={(connection) => void refreshApps(connection)}
              view={view}
              workspaceId={workspaceId}
            />
          ) : workspaceId ? (
            <Skeleton
              label={t("appstoreconnect.loadingBinding")}
              rows={3}
              variant="rows"
            />
          ) : null}
        </section>
      ) : null}
      {editor ? (
        <AppStoreConnectKeyDialog
          connection={editor.connection}
          onClose={() => setEditor(undefined)}
          onSaved={(connection) => void saved(connection)}
        />
      ) : null}
      {revoking ? (
        <Dialog
          busy={deleting}
          description={t("appstoreconnect.revokeDescription")}
          footer={
            <ButtonRow align="end">
              <Button
                disabled={deleting}
                onClick={() => setRevoking(undefined)}
                size="sm"
                variant="ghost"
              >
                {t("common:actions.cancel")}
              </Button>
              <Button
                busy={deleting}
                onClick={() => void revoke()}
                size="sm"
                variant="danger"
              >
                {t("appstoreconnect.revokeConfirm")}
              </Button>
            </ButtonRow>
          }
          layout="compact"
          onClose={() => setRevoking(undefined)}
          title={t("appstoreconnect.revokeTitle", {
            name: revoking.label,
          })}
        >
          <p>{t("appstoreconnect.revokeBody")}</p>
        </Dialog>
      ) : null}
    </ConnectorSection>
  );
}

function AppStoreConnectBinding({
  workspaceId,
  view,
  connections,
  apps,
  accessLevels,
  currentUserId,
  disabled,
  onChanged,
  onNotice,
  onRefreshApps,
}: {
  workspaceId: string;
  view: WorkspaceExternalAccounts;
  connections: AppStoreConnectConnection[];
  apps: Record<string, AppsState>;
  accessLevels: ExternalAccessLevel[];
  currentUserId: string;
  disabled: boolean;
  onChanged: (view: WorkspaceExternalAccounts) => void;
  onNotice: (message: string, tone?: ToastTone) => void;
  onRefreshApps: (connection: AppStoreConnectConnection) => void;
}) {
  const { t } = useTranslation(["externalAccounts", "common"]);
  const accounts = view.accounts.filter(
    (account) =>
      account.provider === "appstoreconnect" &&
      account.ownerUserId === currentUserId,
  );
  const usableConnections = connections.filter((connection) =>
    accounts.some((account) => account.id === connection.accountId),
  );
  const [accountId, setAccountId] = useState(
    usableConnections[0]?.accountId ?? "",
  );
  const account = accounts.find((entry) => entry.id === accountId);
  const connection = connections.find((entry) => entry.accountId === accountId);
  const binding = view.bindings.find((entry) => entry.accountId === accountId);
  const [selected, setSelected] = useState<string[]>(
    binding?.resourceIds ?? [],
  );
  const [access, setAccess] = useState(binding?.access || "read");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const visible = accountId ? apps[accountId] : undefined;
  const availableApps = visible?.apps ?? [];
  const unknown = selected.filter(
    (id) => !availableApps.some((app) => app.id === id),
  );

  useEffect(() => {
    const current = view.bindings.find(
      (entry) => entry.accountId === accountId,
    );
    setSelected(current?.resourceIds ?? []);
    setAccess(current?.access || "read");
    setError("");
  }, [accountId]);

  useEffect(() => {
    if (!accountId && usableConnections[0]?.accountId)
      setAccountId(usableConnections[0].accountId);
  }, [usableConnections, accountId]);

  async function save(remove = false) {
    if (!account || (!remove && !selected.length)) return;
    setSaving(true);
    setError("");
    try {
      const ownIDs = new Set(
        accounts
          .filter((entry) => entry.ownerUserId === currentUserId)
          .map((entry) => entry.id),
      );
      const ids = view.bindings
        .filter(
          (entry) =>
            entry.accountId !== accountId && ownIDs.has(entry.accountId),
        )
        .map((entry) => entry.accountId);
      if (!remove) ids.push(accountId);
      let next = await setWorkspaceExternalAccounts(
        workspaceId,
        Array.from(new Set(ids)),
        remove ? {} : { [accountId]: selected },
      );
      if (!remove && binding?.access !== access)
        next = await setWorkspaceAccountAccess(workspaceId, accountId, access);
      onChanged(next);
      onNotice(
        t(
          remove
            ? "appstoreconnect.unboundNotice"
            : "appstoreconnect.boundNotice",
          { name: connection?.label || account.label },
        ),
      );
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <FormLayout>
      <SelectMenu
        ariaLabel={t("appstoreconnect.identity")}
        disabled={disabled || saving}
        onChange={setAccountId}
        options={accounts.map((entry) => ({
          detail: entry.displayName || entry.subject,
          disabled: !accountUsable(entry),
          label: entry.label,
          value: entry.id,
        }))}
        placeholder={t("appstoreconnect.chooseIdentity")}
        value={accountId}
      />
      {account ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-ink-muted">
          <Badge tone={statusTone(account.status)}>
            {statusLabel(account.status)}
          </Badge>
          {connection ? (
            <code>
              {connection.keyId} · {connection.issuerId}
            </code>
          ) : null}
        </div>
      ) : null}
      {error ? <Alert title={error} tone="error" /> : null}
      {visible?.busy && !visible.apps ? (
        <Skeleton
          label={t("appstoreconnect.loadingApps")}
          rows={4}
          variant="rows"
        />
      ) : visible?.error ? (
        <Alert
          actions={
            connection ? (
              <Button size="sm" onClick={() => onRefreshApps(connection)}>
                {t("connect.tryAgain")}
              </Button>
            ) : undefined
          }
          title={visible.error}
          tone="error"
        />
      ) : (
        <ul aria-busy={visible?.busy || undefined} className="grid min-w-0">
          {availableApps.map((app) => (
            <li key={app.id}>
              <CheckLabel>
                <Checkbox
                  checked={selected.includes(app.id)}
                  disabled={disabled || saving}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setSelected((current) =>
                      checked
                        ? Array.from(new Set([...current, app.id]))
                        : current.filter((id) => id !== app.id),
                    );
                  }}
                />
                <span>
                  <strong>
                    {app.name ||
                      t("appstoreconnect.unnamedApp", { id: app.id })}
                  </strong>
                  <small>
                    {[app.bundleId, app.sku, app.id]
                      .filter(Boolean)
                      .join(" · ")}
                  </small>
                </span>
              </CheckLabel>
            </li>
          ))}
        </ul>
      )}
      {unknown.length ? (
        <ul className="grid min-w-0">
          {unknown.map((id) => (
            <li key={id}>
              <CheckLabel>
                <Checkbox
                  checked
                  disabled={disabled || saving}
                  onChange={() =>
                    setSelected((current) =>
                      current.filter((entry) => entry !== id),
                    )
                  }
                />
                <span>
                  <strong>{id}</strong>
                  <small>{t("appstoreconnect.unverifiedApp")}</small>
                </span>
              </CheckLabel>
            </li>
          ))}
        </ul>
      ) : null}
      {!visible?.busy && !availableApps.length && !unknown.length ? (
        <MutedText>{t("appstoreconnect.noApps")}</MutedText>
      ) : null}
      {account ? (
        <AppStoreConnectAccessLevels
          account={account}
          disabled={disabled || saving}
          onChange={setAccess}
          value={access}
        />
      ) : null}
      <ButtonRow align="end">
        <Button
          busy={saving}
          disabled={
            disabled ||
            !accountId ||
            !selected.length ||
            unknown.length > 0 ||
            (account ? !accountUsable(account) : true)
          }
          onClick={() => void save()}
          size="sm"
          variant="primary"
        >
          {t("appstoreconnect.saveBinding")}
        </Button>
        {binding ? (
          <Button
            disabled={disabled || saving}
            onClick={() => void save(true)}
            size="sm"
            variant="ghost"
          >
            {t("appstoreconnect.removeBinding")}
          </Button>
        ) : null}
      </ButtonRow>
      <MutedText>{t("appstoreconnect.consumption")}</MutedText>
    </FormLayout>
  );
}
