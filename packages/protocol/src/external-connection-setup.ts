/**
 * Setting up a device-owned external connection on another device
 * (docs/external-connections.md, "Setup on another device").
 *
 * A gateway's installer may register setup metadata with
 * `foundry-worker connection add --setup-command …`. The server offers that
 * connection on the account's other devices: the person copies the command
 * and runs it there, or Foundry runs it for them where remote commands are
 * allowed. The installer reports its steps with
 * `foundry-worker connection progress`. Foundry stays gateway-neutral: it
 * only shows and runs the command a gateway registered.
 */

/** How the installer signs the person in to the gateway. */
export type ExternalConnectionSignIn = "device_code" | "browser" | "none";

/** What a gateway registered for setting the connection up elsewhere. */
export interface ExternalConnectionSetupInfo {
  /** One shell line the device's own account runs; never a secret. */
  command: string;
  /** The gateway's https page about it, if any. */
  url?: string;
  signIn?: ExternalConnectionSignIn;
  /** When this command was registered on the device (set by the worker). */
  registeredAt?: string;
}

export type ExternalConnectionSetupProgressState =
  "installing" | "installed" | "waiting_sign_in" | "signed_in" | "failed";

/** What an installer last reported with `connection progress`. */
export interface ExternalConnectionSetupProgress {
  profileId: string;
  state: ExternalConnectionSetupProgressState;
  updatedAt: string;
  /** The https page that completes sign-in. */
  signInUrl?: string;
  /** The code the person confirms there (device-code sign-in). */
  userCode?: string;
  message?: string;
}

export type ExternalConnectionSetupRunState =
  "running" | "succeeded" | "failed" | "cancelled" | "timed_out";

/** A setup command Foundry runs on the device (Set it up for me). */
export interface ExternalConnectionSetupRun {
  runId: string;
  profileId: string;
  state: ExternalConnectionSetupRunState;
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  /** Output from `offset` on (stdout and stderr together). */
  output: string;
  offset: number;
  /** Ask again with `after` = this for what follows. */
  nextOffset: number;
  /** Earlier output was dropped (the run keeps its last 256 KiB). */
  truncated?: boolean;
}

/** The connection as registered on the device right now. */
export interface ExternalConnectionLiveState {
  helperAvailable: boolean;
  check: {
    status: "unchecked" | "passed" | "failed";
    checkedAt?: string;
    message?: string;
  };
}

/** read_external_connection_setup (external_connection_setup_v1). */
export interface ReadExternalConnectionSetupPayload {
  profileId: string;
  /** Output of this run from `after` on. */
  runId?: string;
  after?: number;
}

export interface ExternalConnectionSetupReadReply {
  /** Absent when the connection is not registered on the device. */
  connection?: ExternalConnectionLiveState;
  progress?: ExternalConnectionSetupProgress;
  /** The asked run, else the latest run for the connection. */
  run?: ExternalConnectionSetupRun;
  /** The owner's setting on the device, as the worker enforces it. */
  remoteCommands: boolean;
  error?: string;
  errorCode?: string;
}

/** start_external_connection_setup: the command comes from the server's record. */
export interface StartExternalConnectionSetupPayload {
  profileId: string;
  command: string;
}

export interface CancelExternalConnectionSetupPayload {
  profileId: string;
  runId: string;
}

/**
 * Where a connection stands on one device, with the one action the picker
 * offers for it: ready → select; not_set_up → Set up…; in_progress → View
 * progress…; waiting_sign_in → Finish sign-in…; unchecked → Check…;
 * check_failed / setup_failed → Retry….
 */
export type ExternalConnectionSetupStage =
  | "ready"
  | "not_set_up"
  | "in_progress"
  | "waiting_sign_in"
  | "unchecked"
  | "check_failed"
  | "setup_failed";

export interface ExternalConnectionOffer {
  profileId: string;
  label: string;
  runtime: "claude";
  model?: string;
  models?: string[];
  /**
   * The newest setup command any of the account's devices registered for
   * this id (this device's own first). Absent when none did.
   */
  setup?: ExternalConnectionSetupInfo;
  /** sha256 of setup.command; a run request names it. */
  setupDigest?: string;
  /** Where `setup` was registered. */
  setupSource?: { deviceId: string; label: string };
  /** Different commands other devices registered for the same id. */
  otherSetups?: {
    deviceId: string;
    label: string;
    command: string;
    registeredAt?: string;
  }[];
  /** Other devices of the account that have it. */
  sourceDevices: { id: string; label: string }[];
  stage: ExternalConnectionSetupStage;
  /** The failure, verbatim, for check_failed / setup_failed. */
  detail?: string;
}

/** GET /api/devices/{deviceId}/external-connection-setups */
export interface ExternalConnectionOffersResponse {
  deviceId: string;
  offers: ExternalConnectionOffer[];
}

export type ExternalConnectionRemoteUnavailable =
  "offline" | "old_worker" | "remote_commands_off" | "no_command";

/** GET /api/devices/{deviceId}/external-connection-setups/{profileId} */
export interface ExternalConnectionSetupDetail {
  offer: ExternalConnectionOffer;
  device: {
    id: string;
    label: string;
    /** The OS account the worker runs as. */
    user?: string;
    os?: string;
    online: boolean;
  };
  /** Read from the device just now (false: from its last report). */
  live: boolean;
  progress?: ExternalConnectionSetupProgress;
  run?: ExternalConnectionSetupRun;
  remote: {
    available: boolean;
    reason?: ExternalConnectionRemoteUnavailable;
  };
}
