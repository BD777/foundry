/**
 * The Connectors module's catalog and its device-held kind (docs/connectors.md).
 * A connector is described by data (apps/server/internal/connectors/catalog.json);
 * platform quirks live in small adapters named by `adapter`. A server-held
 * connector (Feishu) keeps its credential on the server and is described by
 * external-accounts.ts; a device-held one (AWS CLI, an extension's) keeps its credential on
 * the device, and the server only ever sees the metadata below. These mirror
 * apps/server/internal/store/device_connectors.go.
 */

import type {
  ConnectorConfiguration,
  ConnectorDescriptor,
  ConnectorExtensionSource,
  ConnectorRequirementsCheck,
  ConnectorSourceAccessCheck,
  DeviceConnectorState,
  ConnectorExtensionError,
} from "./contract.gen.js";
export type {
  ConnectorAuthorizationGroup,
  ConnectorAuthorizationScope,
  ConnectorAuthorizationState,
  ConnectorConfiguration,
  ConnectorDescriptor,
  ConnectorExtensionRepository,
  ConnectorExtensionSource,
  ConnectorField,
  ConnectorHolding,
  ConnectorExtensionError,
  ConnectorModelAccess,
  ConnectorOption,
  ConnectorPackage,
  ConnectorPackageDevice,
  ConnectorPackageSkills,
  ConnectorPackageTool,
  ConnectorPackageUpstream,
  ConnectorPackageView,
  ConnectorPermissions,
  ConnectorProvides,
  ConnectorRequirement,
  ConnectorScopeChange,
  ConnectorScopeSource,
  ConnectorServerHeldSpec,
  ConnectorServerHeldAccess,
  ConnectorServerHeldAccessBy,
  ConnectorServerHeldAccessLevel,
  ConnectorServerHeldAccessLevels,
  ConnectorServerHeldFieldOptions,
  ConnectorServerHeldInstance,
  ConnectorServerHeldInstanceInput,
  ConnectorServerHeldInstancesView,
  ConnectorServerHeldDevice,
  ConnectorServerHeldDeviceCheck,
  ConnectorServerHeldNetwork,
  ConnectorServerHeldNetworkPath,
  ConnectorServerHeldOptionsExtract,
  ConnectorServerHeldProbe,
  ConnectorServerHeldProbeExtract,
  ConnectorServerHeldProbeResult,
  ConnectorServerHeldProbeValues,
  ConnectorServerHeldRoute,
  ConnectorServerHeldRoutesExtract,
  ConnectorServerHeldSession,
  ConnectorServerHeldStep,
  ConnectorServerHeldUpstream,
  ConnectorRepositoryAccess,
  ConnectorRequirementsCheck,
  ConnectorSetup,
  ConnectorShowWhen,
  ConnectorSignIn,
  ConnectorSignInMethod,
  ConnectorSignInRepeat,
  ConnectorSourceAccess,
  ConnectorSourceAccessCheck,
  ConnectorTool,
  DeviceConnectorSessionCheck,
  DeviceConnectorState,
  DeviceConnectorStatus,
  DeviceConnectorUse,
  SetConnectorPackageDevicesInput,
} from "./contract.gen.js";

export type ConnectorAuthorizationChallenge =
  | { kind: "url"; url: string; userCode?: string }
  | { kind: "qr_image"; imageUrl?: string }
  | { kind: "local_interaction"; instruction: string };

/** Text in the person's language: `labels["zh-CN"]`, falling back to `label`. */
export type LocalizedText = Record<string, string>;

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
  /**
   * After approving, the page shows a code the person pastes back here
   * (sign-in/code), e.g. `aws login --remote`.
   */
  codeEntry?: boolean;
  /**
   * What the person pastes back: the code the page shows (absent), or the
   * whole address the browser landed on after approving (`aliyun configure
   * --mode OAuth --no-browser`).
   */
  codeEntryFormat?: "callback_url";
  error?: string;
  /** The connector's state once the sign-in completed. */
  state?: DeviceConnectorState;
}

/** One of the person's devices with its device-held connectors. */
export interface DeviceConnectorDevice {
  deviceId: string;
  name: string;
  online: boolean;
  /** Kinds an extension on this device provides; others are built in. */
  extensionKinds?: string[];
  /** The extensions installed on the device, with their source and commits. */
  extensions?: ConnectorExtensionSource[];
  /** Descriptors the server refused for an extension on this device. */
  extensionErrors?: ConnectorExtensionError[];
  /**
   * Connector kinds being read on the device right now; their states are
   * the last readings until the read lands (the page polls meanwhile).
   */
  checking?: string[];
  /** Installs running on the device, with their latest progress. */
  progress?: ConnectorProgressPayload[];
  states: DeviceConnectorState[];
}

/** One device's explanation for a connector in the restricted group. */
export interface ConnectorRestrictedDevice {
  deviceId: string;
  name: string;
  online: boolean;
  requirementsCheck?: ConnectorRequirementsCheck;
  accessCheck?: ConnectorRestrictedAccessCheck;
  /** The via connector's displayed name, when it is still known. */
  viaLabel?: string;
}

export interface ConnectorRestrictedAccessCheck extends ConnectorSourceAccessCheck {
  via: string;
}

/** A connector hidden from the main picker until one device can use it. */
export interface ConnectorRestricted {
  connector: ConnectorDescriptor;
  devices: ConnectorRestrictedDevice[];
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

export type DeviceConnectorAction =
  | "status"
  | "requirements"
  | "repository_access"
  | "install"
  | "configure"
  | "sign_in_begin"
  | "sign_in_poll"
  | "sign_in_dismiss"
  | "sign_in_input"
  | "sign_out"
  | "extension_request";

/** connector_request: one action on a device-held connector. */
export interface ConnectorRequestPayload {
  action: DeviceConnectorAction;
  connector: ConnectorDescriptor;
  /** status: re-read now instead of using a reading a few seconds old. */
  fresh?: boolean;
  authorizationId?: string;
  authorizationRevision?: number;
  operationId?: string;
  /** sign_in_begin: what the person chose (connector-specific, e.g. AWS method). */
  signInOptions?: Record<string, string>;
  /** configure: non-secret profile settings the person changed. */
  configuration?: ConnectorConfiguration;
  /** sign_in_input: what the person typed (an authorization code). */
  input?: string;
  /** repository_access: the repository the provider connector should read. */
  repository?: string;
  /** extension_request: one upstream exchange for a server-held instance. */
  extension?: ConnectorExtensionHTTPRequest;
}

/** One HTTP exchange a device performs for a server-held extension instance. */
export interface ConnectorExtensionHTTPRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Base64-encoded request body. */
  body?: string;
  timeoutSeconds: number;
}

/** What the device observed from that upstream exchange. */
export interface ConnectorExtensionHTTPResponse {
  status: number;
  headers: Record<string, string[]>;
  /** Base64-encoded response body. */
  body: string;
  error?: string;
}

/** connector_reply */
export interface ConnectorReplyPayload {
  /** Daemon-only PNG; never persisted in state or returned in browser JSON. */
  authorizationImage?: string;
  /** deviceId and expiringSince are the server's to fill. */
  state?: DeviceConnectorState;
  signIn?: DeviceConnectorSignIn;
  /** requirements/repository_access: a non-secret visibility result. */
  requirementsCheck?: ConnectorRequirementsCheck;
  sourceAccessCheck?: ConnectorSourceAccessCheck;
  extension?: ConnectorExtensionHTTPResponse;
  error?: string;
}

/**
 * connector_progress (worker → server, unanswered): how a running install
 * is going. The server keeps the latest for the devices list.
 */
export interface ConnectorProgressPayload {
  kind: string;
  phase: "downloading" | "verifying" | "installing" | "checking";
  receivedBytes?: number;
  /** Known when the download names its length. */
  totalBytes?: number;
  bytesPerSecond?: number;
  /** When the server received it (filled by the server). */
  at?: string;
}

/**
 * GET /api/connectors: every connector the person can use, for the
 * Connectors page's tabs: the built-in ones and those extensions on the
 * person's own devices provide.
 */
export interface ConnectorCatalogView {
  connectors: ConnectorDescriptor[];
  restrictedConnectors?: ConnectorRestricted[];
}
