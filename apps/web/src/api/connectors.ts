import type {
  CloudflareActivityEntry,
  ConnectExternalAccountInput,
  DeviceConnectorBindingInput,
  DeviceConnectorSignIn,
  DeviceConnectorState,
  DeviceConnectorsView,
  WorkspaceDeviceConnectors,
  ExternalAccount,
  ExternalAccountLogin,
  ExternalAccountUpdate,
  ExternalAccountsView,
  ExternalProviderApp,
  SaveExternalProviderAppInput,
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

// Device-held connectors: the login stays on the device; these ask the
// device's worker through the server and return what it read.

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

/** Starts the tool's own sign-in on the device: the page to approve on. */
export function beginDeviceConnectorSignIn(
  deviceId: string,
  kind: string,
  requestId: string,
  authorization?: { id: string; revision: number },
  /** What the person chose before a browser sign-in (AWS method, Region…). */
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
): Promise<ExternalAccountLogin> {
  return request("POST", "/api/connectors/cloudflare/sign-in", {
    body: { requestId, accountId },
  });
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
export async function getCloudflareBindingWorkspaces(): Promise<
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
    request<Array<{ id: string; label: string; status: string }>>(
      "GET",
      "/api/devices",
    ),
  ]);
  const names = new Map(devices.map((d) => [d.id, d]));
  return workspaces
    .filter(
      (w) =>
        !w.archivedAt &&
        (w.accessRole === "owner" || w.accessRole === "maintainer") &&
        names.get(w.deviceId ?? "")?.status !== "removed",
    )
    .map((w) => ({
      id: w.id,
      name: w.name,
      detail: [names.get(w.deviceId ?? "")?.label, w.localPath ?? w.id]
        .filter(Boolean)
        .join(" · "),
    }));
}
