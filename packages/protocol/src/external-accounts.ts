/**
 * External accounts: a person's logins at third-party platforms (first:
 * Feishu, used by feishu-cli), connected and refreshed by the server, bound
 * to workspaces and handed to sessions as short-lived access tokens. These
 * mirror apps/server/internal/store/external_accounts.go.
 */

/** Who holds an account's credential. */
export type ExternalCredentialMode = "server_held" | "device_local";

export type ExternalAccountStatus =
  "ready" | "expiring" | "needs_reauth" | "revoked";

/** Who may connect through a provider app. */
export type ExternalAppVisibility = "personal" | "instance";

export interface ExternalProvider {
  kind: string;
  label: string;
  credentialMode: ExternalCredentialMode;
  authMethods: string[];
  tools: string[];
  defaultBaseUrl?: string;
  alwaysScopes?: string[];
}

/** An OAuth client registration; its secret is write-only. */
export interface ExternalProviderApp {
  id: string;
  provider: string;
  ownerUserId: string;
  visibility: ExternalAppVisibility;
  label: string;
  clientId: string;
  baseUrl?: string;
  hasSecret: boolean;
  createdVia: string;
  createdAt: string;
  updatedAt: string;
}

export interface SaveExternalProviderAppInput {
  provider: string;
  label: string;
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  visibility?: ExternalAppVisibility;
}

export interface ExternalAccount {
  id: string;
  provider: string;
  appId: string;
  ownerUserId: string;
  label: string;
  mode: ExternalCredentialMode;
  status: ExternalAccountStatus;
  statusDetail?: string;
  subject?: string;
  displayName?: string;
  tenant?: string;
  grantedScopes?: string[];
  keepAlive: boolean;
  authTime?: string;
  authExpiresAt?: string;
  accessExpiresAt?: string;
  refreshExpiresAt?: string;
  lastRefreshedAt?: string;
  /** "login", "session", "keep_alive" or "manual". */
  lastRefreshBy?: string;
  lastUsedAt?: string;
  workspaceIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ExternalAccountBinding {
  workspaceId: string;
  accountId: string;
  grantedBy: string;
  createdAt: string;
}

/** One line of an account's audit trail; never a token. */
export interface ExternalAccountEvent {
  id: number;
  accountId: string;
  kind: string;
  detail?: string;
  sessionId?: string;
  deviceId?: string;
  actorId?: string;
  createdAt: string;
}

export interface ExternalAccountUpdate {
  label?: string;
  keepAlive?: boolean;
}

export interface ConnectExternalAccountInput {
  appId: string;
  label?: string;
  scopes?: string[];
}

/** A device-flow login in progress; it never carries a token. */
export interface ExternalAccountLogin {
  id: string;
  provider: string;
  appId: string;
  /** pending, complete or failed. */
  status: "pending" | "complete" | "failed";
  verificationUri?: string;
  verificationUriComplete?: string;
  userCode?: string;
  expiresAt?: string;
  intervalSeconds?: number;
  requestedScopes?: string[];
  error?: string;
  account?: ExternalAccount;
}

/** A short-lived access token minted for a session's device. */
export interface ExternalAccountToken {
  accountId: string;
  accessToken: string;
  tokenType: string;
  expiresAt: string;
  scope?: string;
}

/**
 * What run_session carries for one account a session may act as: the
 * tool profile to write, the app credentials the tool insists on and a
 * minted access token. Never the refresh token.
 */
export interface ExternalAccountMaterial {
  accountId: string;
  provider: string;
  label: string;
  tool: string;
  profileName: string;
  clientId: string;
  clientSecret?: string;
  baseUrl?: string;
  accessToken: string;
  tokenType: string;
  expiresAt: string;
  scope?: string;
  subject?: string;
  displayName?: string;
}

export interface WorkspaceExternalAccounts {
  workspaceId: string;
  bindings: ExternalAccountBinding[];
  /** The bound accounts, plus the caller's own unbound ones. */
  accounts: ExternalAccount[];
}

export interface SetWorkspaceExternalAccountsInput {
  accountIds: string[];
}

export interface ExternalAccountsView {
  providers: ExternalProvider[];
  apps: ExternalProviderApp[];
  accounts: ExternalAccount[];
  /** False when the server has no secret store key. */
  secretsConfigured: boolean;
}

export interface ExternalAccountDetail {
  account: ExternalAccount;
  events: ExternalAccountEvent[];
}
