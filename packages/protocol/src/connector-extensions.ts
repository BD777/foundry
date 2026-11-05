/**
 * Connector extensions (docs/connector-extensions.md): a connector that
 * lives outside Foundry, installed on a device by its owner. An extension
 * is a folder with `foundry-extension.json` and a program the worker starts
 * and talks to with JSON-RPC 2.0, one message per line on stdin/stdout
 * (stderr is never read). One process per extension, started when needed
 * and ended after a while idle; every request is the worker's, none is
 * the agent's.
 */

import type {
  ConnectorDescriptor,
  ConnectorExtensionRepository,
  ConnectorSetup,
} from "./connectors.js";

/** The protocol version this file describes. */
export const connectorExtensionProtocol = 1;

/** `foundry-extension.json`. */
export interface ConnectorExtensionManifest {
  manifestVersion: 1;
  /** 1–32 lowercase letters, digits or dashes, starting with a letter. */
  id: string;
  name: string;
  version: string;
  /** The extension protocol versions it speaks. */
  protocol: number;
  /**
   * The program: `command` is an absolute path, a path inside the extension
   * ("${extensionDir}/bin/x"), "node" (the worker's own Node.js) or a name
   * found on the device's PATH. `${extensionDir}` and `${dataDir}` are
   * replaced in `args`.
   */
  entry?: { command: string; args?: string[] };
  /**
   * The connectors it provides: device-held, adapter "extension:<id>"
   * (both filled in by the worker when left out).
   */
  connectors: ConnectorDescriptor[];
  /**
   * A declarative extension (no `entry`): how the worker drives each
   * connector's own command line, by connector kind. In the manifest file
   * it is written as each connector's `cli`; it never leaves the device.
   */
  cli?: Record<string, ExtensionCli>;
  /** How to install it on the owner's other devices. */
  setup?: ConnectorSetup;
  /**
   * The git folder it is published in: the owner's other devices install
   * and update it from there with one click.
   */
  source?: ConnectorExtensionRepository;
}

/** An installed extension, as `foundry-worker extension list` shows it. */
export interface InstalledConnectorExtension {
  id: string;
  name: string;
  version: string;
  /** Where its files are (a copy under the worker's state root). */
  dir: string;
  /** SHA-256 over its files, checked before every start. */
  sha256: string;
  installedAt: string;
  connectors: string[];
  /** Installed from this git folder (not a local folder). */
  source?: ConnectorExtensionRepository;
  commit?: string;
  /** The commit source.ref pointed at when last looked, and when. */
  latestCommit?: string;
  latestCheckedAt?: string;
}

/**
 * extension_request (server → worker), for the device's owner: install or
 * update an extension from a git folder, or remove one.
 */
export interface ExtensionRequestPayload {
  action: "install" | "remove";
  source?: ConnectorExtensionRepository;
  /** remove: the extension. */
  extensionId?: string;
}

/** extension_reply: what changed, or why nothing did. */
export interface ExtensionReplyPayload {
  action?: "created" | "updated" | "unchanged" | "removed";
  extension?: InstalledConnectorExtension;
  error?: string;
}

/** initialize (worker → extension), the first request. */
export interface ExtensionInitializeParams {
  protocolVersion: number;
  extensionId: string;
  extensionDir: string;
  /** A private folder the extension may keep state in; kept across updates. */
  dataDir: string;
  worker: { version: string };
}

export interface ExtensionInitializeResult {
  protocolVersion: number;
}

/** connector.status: the login as the tool reads it; no credential. */
export interface ExtensionStatusResult {
  /** false: the tool is missing (the connector reads as not installed). */
  installed?: boolean;
  /**
   * "foundry": the copy Foundry installed ($FOUNDRY_TOOLS_BIN, an npm tool
   * the worker installs and upgrades); "device": the device's own.
   */
  installSource?: "foundry" | "device";
  version?: string;
  signedIn: boolean;
  /** A name the tool shows for the login; never an email or token. */
  identity?: string;
  sites?: string[];
  expiresAt?: string;
  authorizations?: {
    id: string;
    revision: number;
    status: "ready" | "needs_auth" | "expired" | "unknown" | "unavailable";
    reason?: "bootstrap_available" | "cli_upgrade" | "check_failed";
  }[];
}

/**
 * A sign-in step: what the person must do now. A QR image is written to
 * `<scratch>/sign-in.png` and named by challenge kind "qr_image".
 */
export interface ExtensionSignInStep {
  status: "pending" | "complete" | "expired" | "denied" | "failed";
  challenge?:
    | { kind: "url"; url: string; userCode?: string }
    | { kind: "qr_image" }
    | { kind: "local_interaction"; instruction: string };
  verificationUrl?: string;
  userCode?: string;
  /** The person pastes a code the approval page shows (connector.signIn.input). */
  codeEntry?: boolean;
  error?: string;
}

/**
 * modelAccess.list: the model providers a model-access connector gives
 * this device. Each becomes a device profile; a session using it starts
 * `session.command` per native process, speaking foundry.connection.v1
 * (docs/connector-extensions.md, "模型接入").
 */
export interface ExtensionModelProfile {
  /** The device profile id (1–64 lowercase letters, digits, underscores). */
  id: string;
  label: string;
  runtime: "claude";
  model: string;
  models: string[];
  /**
   * The verified, non-secret identity the session helper must confirm.
   * Empty only with `problem`: the worker then keeps the last verified one.
   */
  identity: string;
  session: { command: string; args?: string[] };
  /**
   * Still joined but not usable now (its service is down, its gateway did
   * not answer): the extension's own sentence. The profile stays on the
   * device, unavailable with this reason; only a list without it removes it.
   */
  problem?: string;
}

export interface ExtensionModelAccessResult {
  profiles: ExtensionModelProfile[];
}

/**
 * The requests, by method. Every params object carries `kind`, the
 * connector it is about; sign-in methods also get `scratch`, a private
 * folder removed after the call.
 */
export interface ConnectorExtensionMethods {
  initialize: {
    params: ExtensionInitializeParams;
    result: ExtensionInitializeResult;
  };
  "connector.status": {
    params: { kind: string };
    result: ExtensionStatusResult;
  };
  "connector.signIn.begin": {
    params: { kind: string; scratch: string; options: Record<string, string> };
    result: ExtensionSignInStep;
  };
  "connector.signIn.poll": {
    params: { kind: string };
    result: ExtensionSignInStep;
  };
  "connector.signIn.input": {
    params: { kind: string; input: string };
    result: Record<string, never>;
  };
  "connector.signIn.cancel": {
    params: { kind: string };
    result: Record<string, never>;
  };
  "connector.signOut": {
    params: { kind: string };
    result: Record<string, never>;
  };
  "connector.install": {
    params: { kind: string };
    result: Record<string, never>;
  };
  "connector.authorization.begin": {
    params: { kind: string; scratch: string; group: string; revision: number };
    result: { step: ExtensionSignInStep; continuation?: unknown };
  };
  "connector.authorization.poll": {
    params: {
      kind: string;
      group: string;
      revision: number;
      continuation?: unknown;
    };
    result: ExtensionSignInStep;
  };
  "modelAccess.list": {
    params: { kind: string };
    result: ExtensionModelAccessResult;
  };
  shutdown: { params: Record<string, never>; result: Record<string, never> };
}

/**
 * Notifications the extension may send: `connector.changed` (a login
 * changed outside a request; the worker reads it again) and
 * `connector.progress` (an install's step).
 */
export interface ConnectorExtensionNotifications {
  "connector.changed": { kind: string };
  "connector.progress": {
    kind: string;
    phase: "downloading" | "verifying" | "installing" | "checking";
    receivedBytes?: number;
    totalBytes?: number;
  };
}

/**
 * A connector driven through the tool's own command line, as data
 * (docs/connector-extensions.md, "声明式扩展"): the worker runs
 * `connector.tool.command` with these arguments and reads its JSON answer.
 * Arguments and stdin are templates: `{home}` is the home folder, `{x}` a
 * sign-in field's value, `{/a/b}` a JSON pointer into the item a call runs
 * for (`forEach`, `modelAccess.items`); a value starting with "~/" is
 * expanded. Nothing goes through a shell.
 */
export interface ExtensionCli {
  status: ExtensionCliStatus;
  /** How to read the version: a regular expression with one group. */
  version?: { args: string[]; pattern: string };
  /** Guided sign-in methods, by method id. */
  signIn?: Record<string, ExtensionCliCall>;
  signOut?: ExtensionCliCall;
  modelAccess?: ExtensionCliModelAccess;
}

/** One run of the tool. Success: exit code 0, and `ok` true when named. */
export interface ExtensionCliCall {
  args: string[];
  /** Written to the tool's stdin: where a secret field belongs. */
  stdin?: string;
  timeoutSeconds?: number;
  /** Runs once per item of this array in the status answer. */
  forEach?: string;
  /** A JSON pointer that is true when the call succeeded. */
  ok?: string;
  /** JSON pointers to the tool's own words when it failed. */
  error?: string;
  hint?: string;
}

/** Reading the login; its answer is what other calls' pointers read. */
export interface ExtensionCliStatus extends ExtensionCliCall {
  /** Signed in when every condition holds. */
  signedIn: ExtensionCliCondition[];
  identity?: ExtensionCliValue;
  expiresAt?: ExtensionCliValue;
  /** Signed in but unusable: shown as an error with this message. */
  problems?: { when: ExtensionCliCondition[]; message: string }[];
}

export interface ExtensionCliCondition {
  pointer: string;
  equals?: string | number | boolean;
  /** A non-empty array, object or string. */
  nonEmpty?: boolean;
  /** An array that holds this value. */
  includes?: string;
}

/** A value: at `pointer`, or at `pointer` in each item of `items`, joined. */
export interface ExtensionCliValue {
  pointer: string;
  items?: string;
}

/** Model providers, one per item of an array in the status answer. */
export interface ExtensionCliModelAccess {
  items: string;
  where?: ExtensionCliCondition[];
  /** Templates over the item. */
  id: string;
  label: string;
  model?: string;
  models?: string[];
  /** The per-session helper (foundry.connection.v1) and its arguments. */
  session: { command: string; args: string[] };
  /** The verified identity: the helper run with these, then `pointer`. */
  identity: { args: string[]; pointer: string; timeoutSeconds?: number };
}
