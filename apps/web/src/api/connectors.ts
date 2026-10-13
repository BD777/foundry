import type {
  ConnectExternalAccountInput,
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
): Promise<WorkspaceExternalAccounts> {
  return request("PUT", workspaceAccountsPath(workspaceId), {
    body: { accountIds },
  });
}
