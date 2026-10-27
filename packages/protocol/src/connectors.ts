/**
 * The Connectors module's catalog and its device-held kind (docs/connectors.md).
 * A connector is described by data (apps/server/internal/connectors/catalog.json);
 * platform quirks live in small adapters named by `adapter`. A server-held
 * connector (Feishu) keeps its credential on the server and is described by
 * external-accounts.ts; a device-held one (bytedcli) keeps its credential on
 * the device, and the server only ever sees the metadata below. These mirror
 * apps/server/internal/store/device_connectors.go.
 */

/** Who holds a connector's credential. */
export type ConnectorHolding = "server_held" | "device_held";

/**
 * A condition a device must meet for the connector to work there; where it
 * fails the connector is not offered. `tcp_reachable`: a TCP connection to
 * host:port opens within a few seconds (a private network's front door).
 */
export interface ConnectorRequirement {
  kind: "tcp_reachable";
  host: string;
  port: number;
  /** What the requirement means to a person ("ByteDance network"). */
  label: string;
}

/** The program a connector's sessions use and how Foundry installs it. */
export interface ConnectorTool {
  command: string;
  /** "device": installed outside Foundry; "npm": a managed package. */
  source?: "npm" | "device";
  package?: string;
  /** Where the package comes from; "device" is the device's own npm settings. */
  registry?: string;
}

/** A shared credential requirement; multiple business capabilities can use it. */
export interface ConnectorAuthorizationGroup {
  id: string;
  revision: number;
  label: string;
  labels?: Record<string, string>;
  capabilities: string[];
  credential: "native_login" | "native_web_session";
}

export interface ConnectorAuthorizationState {
  id: string;
  revision: number;
  status: "ready" | "needs_auth" | "expired" | "unknown" | "unavailable";
  checkedAt: string;
  verification: "local_state" | "not_checked";
  /** Adapter code only; never raw provider output or credentials. */
  reason?: "bootstrap_available" | "cli_upgrade" | "check_failed";
}

export type ConnectorAuthorizationChallenge =
  | { kind: "url"; url: string; userCode?: string }
  | { kind: "qr_image"; imageUrl?: string }
  | { kind: "local_interaction"; instruction: string };

export interface ConnectorDescriptor {
  kind: string;
  label: string;
  holding: ConnectorHolding;
  /** The code adapter that handles this connector's quirks. */
  adapter: string;
  tool: ConnectorTool;
  /** Local authentication is managed in the device terminal, not by Foundry. */
  authentication?: "local";
  requires?: ConnectorRequirement[];
  /** A device-held login this close to its expiry is "expiring". */
  expiryReminderDays?: number;
  authorizationGroups?: ConnectorAuthorizationGroup[];
  /**
   * How a session that may not use the device's login is kept from it, with
   * the tool's documented configuration: these variables are set for it.
   */
  isolationEnv?: Record<string, string>;
}

/** Where a device-held connector stands on one device. */
export type DeviceConnectorStatus =
  | "ready"
  | "expiring"
  | "expired"
  | "signed_out"
  | "not_installed"
  | "unavailable"
  | "error";

/**
 * A device-held connector on one device, as last read there. Never a
 * credential: the identity is the label the tool shows (a user name, no
 * email), with the sites signed in and when the login ends.
 */
export interface DeviceConnectorState {
  deviceId: string;
  kind: string;
  status: DeviceConnectorStatus;
  /** Why it is unavailable or failed (a requirement's label, an error). */
  statusDetail?: string;
  installed: boolean;
  version?: string;
  /** "foundry": installed by Foundry's managed tools; "device": the device's own. */
  installSource?: "foundry" | "device";
  /** The newest version the device's package source offers, when known. */
  latestVersion?: string;
  signedIn: boolean;
  identity?: string;
  sites?: string[];
  expiresAt?: string;
  checkedAt: string;
  authorizations?: ConnectorAuthorizationState[];
  /** When a check first found the login inside the reminder window. */
  expiringSince?: string;
}

/** A sign-in through the device's tool, relayed to the person. */
export interface DeviceConnectorSignIn {
  /** Observed progress, never a claim that a timed-out grant failed. */
  phase?: "checking" | "starting" | "awaiting_user" | "verifying";
  authorizationId?: string;
  authorizationRevision?: number;
  challenge?: ConnectorAuthorizationChallenge;
  /** Opaque operation, scoped to the signed-in person, connector and device. */
  operationId?: string;
  expiresAt?: string;
  intervalSeconds?: number;
  status: "pending" | "complete" | "expired" | "denied" | "failed";
  /** The page the person opens (or scans) to approve. */
  verificationUrl?: string;
  userCode?: string;
  error?: string;
  /** The connector's state once the sign-in completed. */
  state?: DeviceConnectorState;
}

/** One of the person's devices with its device-held connectors. */
export interface DeviceConnectorDevice {
  deviceId: string;
  name: string;
  online: boolean;
  /** The device's worker handles device-held connectors. */
  supported: boolean;
  authorizationSupported?: boolean;
  states: DeviceConnectorState[];
}

/** The device-held part of the Connectors page. */
export interface DeviceConnectorsView {
  connectors: ConnectorDescriptor[];
  devices: DeviceConnectorDevice[];
}

/**
 * Explicit workspace sharing of a device login, managed by its owner.
 * The owner's own unsandboxed sessions use ready device logins automatically;
 * `members` lets other members' sessions on that device use it too.
 */
export interface DeviceConnectorBinding {
  workspaceId: string;
  kind: string;
  deviceId: string;
  members: boolean;
  grantedBy: string;
  createdAt: string;
  /** Filled for readers: the device's name and, for its owner only, its state. */
  deviceName?: string;
  state?: DeviceConnectorState;
}

export interface ConnectorExecutionDevice {
  deviceId: string;
  name: string;
}

/** A workspace's device-held bindings and its real execution targets. */
export interface WorkspaceDeviceConnectors {
  workspaceId: string;
  /** Default workspace device plus devices with actual session agents here. */
  executionDevices: ConnectorExecutionDevice[];
  defaultDeviceId: string;
  connectors: ConnectorDescriptor[];
  bindings: DeviceConnectorBinding[];
  devices: DeviceConnectorDevice[];
}

export interface DeviceConnectorBindingInput {
  kind: string;
  deviceId: string;
  members?: boolean;
}

/** Replaces the caller's own bindings in the workspace. */
export interface SetWorkspaceDeviceConnectorsInput {
  bindings: DeviceConnectorBindingInput[];
}

/**
 * run_session: what a session may do with a device-held connector on its
 * device. "device_login": use the device's default login. "none": a session
 * someone other than the device's owner started, kept from the login by
 * the descriptor's isolationEnv.
 */
export interface DeviceConnectorUse {
  /** Last device reading, with expiry evaluated by the server. No credentials. */
  state?: DeviceConnectorState;
  kind: string;
  adapter: string;
  label: string;
  command: string;
  access: "device_login" | "none";
  isolationEnv?: Record<string, string>;
}

export type DeviceConnectorAction =
  | "status"
  | "install"
  | "sign_in_begin"
  | "sign_in_poll"
  | "sign_in_dismiss"
  | "sign_out";

/** connector_request: one action on a device-held connector. */
export interface ConnectorRequestPayload {
  action: DeviceConnectorAction;
  connector: ConnectorDescriptor;
  /** status: re-read now instead of using a reading a few seconds old. */
  fresh?: boolean;
  authorizationId?: string;
  authorizationRevision?: number;
  operationId?: string;
}

/** connector_reply */
export interface ConnectorReplyPayload {
  /** Daemon-only PNG; never persisted in state or returned in browser JSON. */
  authorizationImage?: string;
  /** deviceId and expiringSince are the server's to fill. */
  state?: DeviceConnectorState;
  signIn?: DeviceConnectorSignIn;
  error?: string;
}

/** The worker handles connector_request. */
export const deviceConnectorsCapability = "device_connectors";

/** Worker supports scoped groups and device-local continuation contexts. */
export const connectorAuthorizationCapability = "connector_authorization_v1";
