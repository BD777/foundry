import type {
  AppStoreConnectApp,
  AppStoreConnectConnection,
  CloudflareActivityEntry,
  ConnectorCatalogView,
  ConnectorConfiguration,
  ConnectorExtensionRepository,
  ConnectorPackageView,
  ExtensionReplyPayload,
  ConnectExternalAccountInput,
  DeviceConnectorBindingInput,
  DeviceConnectorSignIn,
  DeviceConnectorState,
  DeviceConnectorsView,
  WorkspaceDeviceConnectors,
  ExternalAccount,
  ExternalAccountLogin,
  ExternalScopeCatalog,
  ExternalAccountUpdate,
  ExternalAccountsView,
  ExternalProviderApp,
  ConnectorServerHeldInstance,
  ConnectorServerHeldInstanceInput,
  ConnectorServerHeldInstancesView,
  ConnectorServerHeldProbeResult,
  SaveExternalProviderAppInput,
  SaveAppStoreConnectKeyInput,
  SetupExternalAccountInput,
  WorkspaceExternalAccounts,
} from "@bd777/foundry-protocol";
import { request } from "./http";

const externalAccountPath = (id: string) =>
  `/api/external-accounts/${encodeURIComponent(id)}`;
const externalAppPath = (id: string) =>
  `/api/external-apps/${encodeURIComponent(id)}`;
const workspaceAccountsPath = (workspaceId: string) =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/external-accounts`;
const appStoreConnectKeyPath = (appId: string) =>
  `/api/connectors/appstoreconnect/keys/${encodeURIComponent(appId)}`;

export function getExternalAccounts(): Promise<ExternalAccountsView> {
  return request("GET", "/api/external-accounts");
}

/** The secret is write-only: sealed by the server, never returned. */
export function createExternalApp(
  input: SaveExternalProviderAppInput,
): Promise<ExternalProviderApp> {
  return request("POST", "/api/external-apps", { body: input });
}

export function deleteExternalApp(appId: string): Promise<unknown> {
  return request("DELETE", externalAppPath(appId));
}

/** Seals the secret the person rotated at the provider; write-only too. */
export function replaceExternalAppSecret(
  appId: string,
  clientSecret: string,
): Promise<ExternalProviderApp> {
  return request("PUT", `${externalAppPath(appId)}/secret`, {
    body: { clientSecret },
  });
}

/** Starts a device-flow login; the answer is the code to show. */
export function connectExternalAccount(
  input: ConnectExternalAccountInput,
): Promise<ExternalAccountLogin> {
  return request("POST", "/api/external-accounts/connect", { body: input });
}

export function setupExternalAccount(
  input: SetupExternalAccountInput,
): Promise<ExternalAccountLogin> {
  return request("POST", "/api/external-accounts/setup", { body: input });
}

export function getExternalAccountLogin(
  loginId: string,
): Promise<ExternalAccountLogin> {
  return request(
    "GET",
    `/api/external-accounts/logins/${encodeURIComponent(loginId)}`,
  );
}

export function updateExternalAccount(
  accountId: string,
  update: ExternalAccountUpdate,
): Promise<ExternalAccount> {
  return request("PATCH", externalAccountPath(accountId), { body: update });
}

export function refreshExternalAccount(
  accountId: string,
): Promise<ExternalAccount> {
  return request("POST", `${externalAccountPath(accountId)}/refresh`);
}

/** "Stop using now": revoked at the provider; held tokens lapse. */
export function revokeExternalAccount(
  accountId: string,
): Promise<ExternalAccount> {
  return request("POST", `${externalAccountPath(accountId)}/revoke`);
}

export function disconnectExternalAccount(accountId: string): Promise<unknown> {
  return request("DELETE", externalAccountPath(accountId));
}

export function getWorkspaceExternalAccounts(
  workspaceId: string,
): Promise<WorkspaceExternalAccounts> {
  return request("GET", workspaceAccountsPath(workspaceId));
}

/** Replaces the caller's own bindings in the workspace. */
export function setWorkspaceExternalAccounts(
  workspaceId: string,
  accountIds: string[],
  resources?: Record<string, string[]>,
): Promise<WorkspaceExternalAccounts> {
  return request("PUT", workspaceAccountsPath(workspaceId), {
    body: { accountIds, resources },
  });
}

/** Sets the access level of the caller's binding of accountId (DEV-092). */
export function setWorkspaceAccountAccess(
  workspaceId: string,
  accountId: string,
  access: string,
): Promise<WorkspaceExternalAccounts> {
  return request(
    "PUT",
    `${workspaceAccountsPath(workspaceId)}/${encodeURIComponent(accountId)}/access`,
    { body: { access } },
  );
}

export function getAppStoreConnectKeys(): Promise<{
  keys: AppStoreConnectConnection[];
}> {
  return request("GET", "/api/connectors/appstoreconnect/keys");
}

/** The .p8 is write-only: the server validates and seals it, never returns it. */
export function createAppStoreConnectKey(
  input: SaveAppStoreConnectKeyInput,
): Promise<AppStoreConnectConnection> {
  return request("POST", "/api/connectors/appstoreconnect/keys", {
    body: input,
  });
}

/** Replaces both public ids and the .p8 after Apple validates the new key. */
export function replaceAppStoreConnectKey(
  appId: string,
  input: SaveAppStoreConnectKeyInput,
): Promise<AppStoreConnectConnection> {
  return request("PUT", appStoreConnectKeyPath(appId), { body: input });
}

/** Revokes Foundry's use of the key and its workspace bindings' access. */
export function revokeAppStoreConnectKey(
  appId: string,
): Promise<AppStoreConnectConnection> {
  return request("DELETE", appStoreConnectKeyPath(appId));
}

export function getAppStoreConnectApps(
  accountId: string,
): Promise<{ apps: AppStoreConnectApp[] }> {
  return request(
    "GET",
    `/api/connectors/appstoreconnect/accounts/${encodeURIComponent(accountId)}/apps`,
  );
}

const serverHeldInstancePath = (kind: string, instanceId?: string) =>
  `/api/connectors/extensions/${encodeURIComponent(kind)}/instances${
    instanceId ? `/${encodeURIComponent(instanceId)}` : ""
  }`;

/** Every server-held instance an extension on the caller's devices provides. */
export function getServerHeldInstances(
  kind: string,
): Promise<ConnectorServerHeldInstancesView> {
  return request("GET", serverHeldInstancePath(kind));
}

/** Validates fields and returns non-secret values, options and probe results. */
export function probeServerHeldInstance(
  kind: string,
  input: ConnectorServerHeldInstanceInput,
): Promise<ConnectorServerHeldProbeResult> {
  return request("POST", `${serverHeldInstancePath(kind)}/probe`, {
    body: input,
  });
}

/** Secrets in the input are validated, sealed by the server and never returned. */
export function createServerHeldInstance(
  kind: string,
  input: ConnectorServerHeldInstanceInput,
): Promise<ConnectorServerHeldInstance> {
  return request("POST", serverHeldInstancePath(kind), { body: input });
}

/** A blank secret keeps the sealed one; Foundry probes before replacing anything. */
export function replaceServerHeldInstance(
  kind: string,
  instanceId: string,
  input: ConnectorServerHeldInstanceInput,
): Promise<ConnectorServerHeldInstance> {
  return request("PUT", serverHeldInstancePath(kind, instanceId), {
    body: input,
  });
}

export function checkServerHeldInstance(
  kind: string,
  instanceId: string,
): Promise<ConnectorServerHeldInstance> {
  return request("POST", `${serverHeldInstancePath(kind, instanceId)}/check`);
}

/** Deletes sealed credentials and cuts this instance off from every session. */
export function revokeServerHeldInstance(
  kind: string,
  instanceId: string,
): Promise<ConnectorServerHeldInstance> {
  return request("DELETE", serverHeldInstancePath(kind, instanceId));
}

// Device-held connectors: the login stays on the device; these ask the
// device's worker through the server and return what it read.

/**
 * Every connector the person can use: the built-in ones and those
 * extensions on their own devices provide (the Connectors page's tabs).
 */
/**
 * Installs (or updates) a connector extension on one of the caller's
 * devices from a git folder; the device fetches it with its own git login.
 */
export function installDeviceExtension(
  deviceId: string,
  input:
    { source: ConnectorExtensionRepository } | { bundledExtensionId: string },
): Promise<ExtensionReplyPayload> {
  return request(
    "POST",
    `/api/devices/${encodeURIComponent(deviceId)}/extensions`,
    { body: input },
  );
}

/** Turns automatic git source updates on or off for an installed extension. */
export function setDeviceExtensionAutoUpdate(
  deviceId: string,
  extensionId: string,
  autoUpdate: boolean,
): Promise<ExtensionReplyPayload> {
  return request(
    "PATCH",
    `/api/devices/${encodeURIComponent(deviceId)}/extensions/${encodeURIComponent(extensionId)}`,
    { body: { autoUpdate } },
  );
}

/** Removes a connector extension from one of the caller's devices. */
export function removeDeviceExtension(
  deviceId: string,
  extensionId: string,
): Promise<ExtensionReplyPayload> {
  return request(
    "DELETE",
    `/api/devices/${encodeURIComponent(deviceId)}/extensions/${encodeURIComponent(extensionId)}`,
  );
}

export function getConnectorCatalog(): Promise<ConnectorCatalogView> {
  return request("GET", "/api/connectors");
}

/** Refreshes every owner device's gated connector checks now. */
export function recheckConnectorAccess(): Promise<ConnectorCatalogView> {
  return request("POST", "/api/connectors/recheck-access");
}

/** The person's connector packages and where each is enabled. */
export function getConnectorPackages(): Promise<ConnectorPackageView[]> {
  return request("GET", "/api/connector-packages");
}

export function getConnectorPackage(
  kind: string,
): Promise<ConnectorPackageView> {
  return request("GET", `/api/connector-packages/${encodeURIComponent(kind)}`);
}

/** Replaces the package's devices after the server preflights every choice. */
export function setConnectorPackageDevices(
  kind: string,
  deviceIds: string[],
): Promise<ConnectorPackageView> {
  return request(
    "PUT",
    `/api/connector-packages/${encodeURIComponent(kind)}/devices`,
    { body: { deviceIds } },
  );
}

export function deleteConnectorPackage(kind: string): Promise<unknown> {
  return request(
    "DELETE",
    `/api/connector-packages/${encodeURIComponent(kind)}`,
  );
}

const deviceConnectorPath = (deviceId: string, kind: string) =>
  `/api/devices/${encodeURIComponent(deviceId)}/connectors/${encodeURIComponent(kind)}`;

/** The person's devices with each device-held connector; refresh reads stale ones first. */
export function getDeviceConnectors(
  refresh = false,
): Promise<DeviceConnectorsView> {
  return request(
    "GET",
    `/api/connectors/devices${refresh ? "?refresh=1" : ""}`,
  );
}

export function checkDeviceConnector(
  deviceId: string,
  kind: string,
): Promise<DeviceConnectorState> {
  return request("POST", `${deviceConnectorPath(deviceId, kind)}/check`);
}

/** Installs or upgrades the connector's tool through Foundry's managed tools. */
export function installDeviceConnector(
  deviceId: string,
  kind: string,
): Promise<DeviceConnectorState> {
  return request("POST", `${deviceConnectorPath(deviceId, kind)}/install`);
}

/** Changes non-secret defaults in the connector's active device profile. */
export function updateDeviceConnectorConfiguration(
  deviceId: string,
  kind: string,
  configuration: ConnectorConfiguration,
): Promise<DeviceConnectorState> {
  return request(
    "PUT",
    `${deviceConnectorPath(deviceId, kind)}/configuration`,
    { body: { configuration } },
  );
}

/** Starts the tool's own sign-in on the device: the page to approve on. */
export function beginDeviceConnectorSignIn(
  deviceId: string,
  kind: string,
  requestId: string,
  authorization?: { id: string; revision: number },
  /** What the person chose before a browser sign-in (for example, its method). */
  signInOptions?: Record<string, string>,
): Promise<DeviceConnectorSignIn> {
  return request("POST", `${deviceConnectorPath(deviceId, kind)}/sign-in`, {
    body: {
      requestId,
      ...(signInOptions ? { signInOptions } : {}),
      ...(authorization
        ? {
            authorizationId: authorization.id,
            authorizationRevision: authorization.revision,
          }
        : {}),
    },
  });
}

export function pollDeviceConnectorSignIn(
  deviceId: string,
  kind: string,
  operationId: string,
  authorization?: { id: string; revision: number },
): Promise<DeviceConnectorSignIn> {
  return request(
    "POST",
    `${deviceConnectorPath(deviceId, kind)}/sign-in/poll`,
    {
      body: {
        operationId,
        ...(authorization
          ? {
              authorizationId: authorization.id,
              authorizationRevision: authorization.revision,
            }
          : {}),
      },
    },
  );
}

/** Hands the code the sign-in page showed to the device's waiting sign-in. */
export function submitDeviceConnectorSignInCode(
  deviceId: string,
  kind: string,
  operationId: string,
  code: string,
): Promise<void> {
  return request(
    "POST",
    `${deviceConnectorPath(deviceId, kind)}/sign-in/code`,
    { body: { operationId, code } },
  );
}

export function signOutDeviceConnector(
  deviceId: string,
  kind: string,
): Promise<DeviceConnectorState> {
  return request("POST", `${deviceConnectorPath(deviceId, kind)}/sign-out`);
}

export function getWorkspaceDeviceConnectors(
  workspaceId: string,
): Promise<WorkspaceDeviceConnectors> {
  return request(
    "GET",
    `/api/workspaces/${encodeURIComponent(workspaceId)}/device-connectors`,
  );
}

/** Replaces the caller's own device bindings in the workspace. */
export function setWorkspaceDeviceConnectors(
  workspaceId: string,
  bindings: DeviceConnectorBindingInput[],
): Promise<WorkspaceDeviceConnectors> {
  return request(
    "PUT",
    `/api/workspaces/${encodeURIComponent(workspaceId)}/device-connectors`,
    { body: { bindings } },
  );
}

export function dismissDeviceConnectorSignIn(
  deviceId: string,
  kind: string,
  operationId: string,
  authorization?: { id: string; revision: number },
): Promise<void> {
  return request(
    "POST",
    `${deviceConnectorPath(deviceId, kind)}/sign-in/dismiss`,
    {
      body: {
        operationId,
        ...(authorization
          ? {
              authorizationId: authorization.id,
              authorizationRevision: authorization.revision,
            }
          : {}),
      },
    },
  );
}

export function beginCloudflareSignIn(
  requestId: string,
  accountId?: string,
  scopes?: string[],
): Promise<ExternalAccountLogin> {
  return request("POST", "/api/connectors/cloudflare/sign-in", {
    body: { requestId, accountId, ...(scopes?.length ? { scopes } : {}) },
  });
}

/** Cloudflare's own scope list (its OAuth metadata). */
export function getCloudflareScopes(): Promise<ExternalScopeCatalog> {
  return request("GET", "/api/connectors/cloudflare/scopes");
}

/** The scopes a login through this app can choose from (Feishu: the app's own). */
export function getExternalAppScopes(
  appId: string,
): Promise<ExternalScopeCatalog> {
  return request(
    "GET",
    `/api/external-apps/${encodeURIComponent(appId)}/scopes`,
  );
}
/** Resolves `{ status: "gone" }` when the sign-in no longer exists. */
export function cancelCloudflareSignIn(
  id: string,
  requestId: string,
): Promise<{ status: "gone" } | undefined> {
  return request(
    "DELETE",
    `/api/connectors/cloudflare/logins/${encodeURIComponent(id)}`,
    { body: { requestId } },
  );
}
export interface CloudflareZone {
  id: string;
  name: string;
  status: string;
  type?: string;
  account?: { id: string; name: string };
}
export function getCloudflareZones(
  accountId: string,
  page = 1,
): Promise<{
  success: boolean;
  result: CloudflareZone[];
  result_info?: { total_pages?: number };
}> {
  return request(
    "GET",
    `/api/connectors/cloudflare/accounts/${encodeURIComponent(accountId)}/zones?page=${page}`,
  );
}
export function getCloudflareActivity(
  accountId: string,
): Promise<{ entries: CloudflareActivityEntry[] }> {
  return request(
    "GET",
    `/api/connectors/cloudflare/accounts/${encodeURIComponent(accountId)}/activity`,
  );
}
export async function getConnectorBindingWorkspaces(): Promise<
  Array<{ id: string; name: string; detail?: string }>
> {
  const [workspaces, devices] = await Promise.all([
    request<
      Array<{
        id: string;
        name: string;
        deviceId?: string;
        localPath?: string;
        archivedAt?: string;
        accessRole?: string;
      }>
    >("GET", "/api/workspaces"),
    request<Array<{ id: string; label: string }>>("GET", "/api/devices"),
  ]);
  const names = new Map(devices.map((d) => [d.id, d]));
  return workspaces
    .filter(
      (w) =>
        !w.archivedAt &&
        (w.accessRole === "owner" || w.accessRole === "maintainer"),
    )
    .map((w) => ({
      id: w.id,
      name: w.name,
      detail: [names.get(w.deviceId ?? "")?.label, w.localPath ?? w.id]
        .filter(Boolean)
        .join(" · "),
    }));
}

export function getCloudflareBindingWorkspaces() {
  return getConnectorBindingWorkspaces();
}
