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
  /** "npm": an npm package through the managed-tools path. */
  source?: "npm";
  package?: string;
  /** Where the package comes from; "device" is the device's own npm settings. */
  registry?: string;
}

export interface ConnectorDescriptor {
  kind: string;
  label: string;
  holding: ConnectorHolding;
  /** The code adapter that handles this connector's quirks. */
  adapter: string;
  tool: ConnectorTool;
  requires?: ConnectorRequirement[];
  /** A device-held login this close to its expiry is "expiring". */
  expiryReminderDays?: number;
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
  /** When a check first found the login inside the reminder window. */
  expiringSince?: string;
}

/** A sign-in through the device's tool, relayed to the person. */
export interface DeviceConnectorSignIn {
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
  states: DeviceConnectorState[];
}

/** The device-held part of the Connectors page. */
export interface DeviceConnectorsView {
  connectors: ConnectorDescriptor[];
  devices: DeviceConnectorDevice[];
}

/**
 * Lets a workspace's sessions on one device use that device's login of a
 * device-held connector; only the device's owner binds it. `members` lets
 * other members' sessions on that device use it too.
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

/** A workspace's device-held bindings, and the caller's devices to bind. */
export interface WorkspaceDeviceConnectors {
  workspaceId: string;
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
  kind: string;
  adapter: string;
  label: string;
  command: string;
  access: "device_login" | "none";
  isolationEnv?: Record<string, string>;
}

export type DeviceConnectorAction =
  "status" | "install" | "sign_in_begin" | "sign_in_poll" | "sign_out";

/** connector_request: one action on a device-held connector. */
export interface ConnectorRequestPayload {
  action: DeviceConnectorAction;
  connector: ConnectorDescriptor;
  /** status: re-read now instead of using a reading a few seconds old. */
  fresh?: boolean;
}

/** connector_reply */
export interface ConnectorReplyPayload {
  /** deviceId and expiringSince are the server's to fill. */
  state?: DeviceConnectorState;
  signIn?: DeviceConnectorSignIn;
  error?: string;
}

/** The worker handles connector_request. */
export const deviceConnectorsCapability = "device_connectors";
