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
  /** What a login asks for when it names no scopes. */
  scopePreset?: ExternalScopePreset;
  /** The provider can create an app for the person during sign-in. */
  registersApps?: boolean;
}

/** A provider's default scope list and where it comes from. */
export interface ExternalScopePreset {
  name: string;
  source: string;
  scopes: string[];
  /** Asked for only on request: a tenant administrator may have to approve them. */
  approvalScopes?: string[];
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
  /** Devices held this app's secret before sessions went through Foundry's
   * gateway: rotate it at the provider, then replace it here. */
  rotateSecret?: boolean;
  /** The app's own name and its organisation's at the provider; empty until read. */
  appName?: string;
  tenantName?: string;
  /** The domain of a connected person's enterprise email ("example.com"):
   * the organisation's label when tenantName needs an app permission. */
  orgDomain?: string;
  /** When the names were last asked for, and why one could not be read. */
  namesCheckedAt?: string;
  namesDetail?: string;
  /** The reader's own accounts connected through the app, by name. */
  accountNames?: string[];
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
  /** The names of the account's app and its organisation, from the app. */
  appName?: string;
  tenantName?: string;
  orgDomain?: string;
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
  /** Re-authorizes this account in place (same id and bindings); the sign-in must be the same user. */
  accountId?: string;
  label?: string;
  /** Replaces the provider's preset when given. */
  scopes?: string[];
  includeApprovalScopes?: boolean;
}

/** Starts a sign-in that first creates an app for the person, then authorizes it. */
export interface SetupExternalAccountInput {
  provider: string;
  /** "feishu" or "lark"; empty is the provider default. */
  brand?: string;
  label?: string;
  /** Replaces the provider's preset when given. */
  scopes?: string[];
  includeApprovalScopes?: boolean;
}

/** A device-flow login in progress; it never carries a token. */
export interface ExternalAccountLogin {
  id: string;
  provider: string;
  appId: string;
  /** pending, complete or failed. */
  status: "pending" | "complete" | "failed";
  /** A setup's phase: confirm the new app, then authorize it. Empty for a plain login. */
  phase?: "register" | "authorize";
  verificationUri?: string;
  verificationUriComplete?: string;
  userCode?: string;
  expiresAt?: string;
  intervalSeconds?: number;
  requestedScopes?: string[];
  error?: string;
  /** The app a setup created, once it exists. */
  app?: ExternalProviderApp;
  account?: ExternalAccount;
  /** Asked for but not granted, once complete. */
  missingScopes?: string[];
  /** The provider page to enable missingScopes on the app. */
  scopeApplyUrl?: string;
}

/**
 * What run_session carries for one account a session may act as: the tool
 * profile to write, the app id, and the gateway handles that stand in for
 * the app secret and the access token. Never a secret or a real token: the
 * tool reaches the provider through the server's gateway.
 */
export interface ExternalAccountMaterial {
  accountId: string;
  provider: string;
  label: string;
  tool: string;
  profileName: string;
  clientId: string;
  gateway?: ExternalAccountGateway;
  /** The handles' expiry for the tool's own checks; the server stops
   * honouring them when the session ends. */
  expiresAt: string;
  scope?: string;
  subject?: string;
  displayName?: string;
}

/** A session's way through the server's gateway for one account. */
export interface ExternalAccountGateway {
  /** Server path the device's loopback forwarder sends requests under. */
  path: string;
  /** Stands in for the app secret. */
  appHandle: string;
  /** Stands in for the user access token. */
  userHandle: string;
  /** Stands in for the user refresh token; the gateway answers its refresh. */
  refreshHandle?: string;
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
