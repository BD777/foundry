// Resources: what a device (or, later, a remote service) offers sessions,
// as one inventory the server keeps. A resource type says what a resource
// does; an instance is one concrete thing of that type at one source (the
// Mac mini's desktop, a device's Chrome, an iOS simulator). Workers detect
// instances and report snapshots (resources_report); the server reconciles
// them, gives each a stable id and lists them (GET /api/resources, MCP
// list_resources). A session holds an instance through a lease
// (acquire_resource) and operates it through the server and the hosting
// device's worker (operate_resource, resource_operate).
//
// The Go side is apps/server/internal/store/resources.go;
// scripts/audit-contract.mjs keeps the interfaces' fields in step.

/** What a resource does. Detectors report these. */
export const resourceTypeIds = [
  "browser",
  "computer_use",
  "simulator",
  "mobile_device",
  "gpu",
  "container_runtime",
  "toolchain",
  "account",
  "disk",
  "compute",
] as const;

export type ResourceTypeId = (typeof resourceTypeIds)[number];

/** The OS a resource runs on or targets. */
export type ResourcePlatform =
  "macos" | "windows" | "linux" | "ios" | "android" | "any";

/**
 * Where an instance stands as the server sees it: available (ready when last
 * seen), busy (available, and a session holds a lease on it), unready (seen,
 * but a session cannot use it yet: see the reason), offline (its source is
 * disconnected; last known values) or gone (its source's last full report no
 * longer has it).
 */
export type ResourceState =
  "available" | "busy" | "unready" | "offline" | "gone";

/**
 * How far a resource is set up. A detector reports the level it actually
 * reached; "verified" is reserved for a real successful use, which no
 * detector ever reports.
 */
export type ResourceReadinessLevel =
  "installed" | "configured" | "permitted" | "verified";

export interface ResourceReadiness {
  /** Whether a session could use it now, as far as detection can tell. */
  ready: boolean;
  level: ResourceReadinessLevel;
  /** Why it is not ready, in words for the person. */
  reason?: string;
  /** What is missing, as codes (e.g. "tcc_screen_recording"). */
  missing?: string[];
}

/**
 * One way to use an instance. Several backends may drive the same instance
 * (one physical desktop, two automation tools); the instance is the unit,
 * not the backend.
 */
export interface ResourceBackend {
  /** e.g. "foundry-worker", "simctl", "adb", "docker". */
  id: string;
  version?: string;
  /**
   * listed: detected only; native_session: only a session on the device
   * itself can use it (its own tools); remote_ops: any session holding a
   * lease operates it through Foundry (operate_resource).
   */
  mode: "listed" | "native_session" | "remote_ops";
  readiness: ResourceReadiness;
}

/** One instance as a detector found it on its device. */
export interface DetectedResource {
  /**
   * Deterministic within the source, e.g. "browser/google-chrome",
   * "simulator/ios/<UDID>"; the server derives the stable id from it.
   */
  key: string;
  type: ResourceTypeId;
  platform: ResourcePlatform;
  name: string;
  /** The detector that found it, as "<id>@<version>". */
  detector: string;
  readiness: ResourceReadiness;
  backends?: ResourceBackend[];
  /** Type-specific facts: a path, a version, a model. Never a secret. */
  details?: Record<string, string>;
}

/** A detector that failed (timeout, error) during a scan. */
export interface ResourceDetectorError {
  /** The detector, as "<id>@<version>". */
  detector: string;
  type: ResourceTypeId;
  error: string;
}

/**
 * resources_report: a worker's whole inventory, sent after hello and
 * whenever it changes. Instances of a detector named in detectorErrors are
 * kept as last known (stale), not dropped.
 */
export interface ResourcesReport {
  /** Version of the worker's scanner (the detector set and its rules). */
  scannerVersion: number;
  scannedAt: string;
  instances: DetectedResource[];
  detectorErrors: ResourceDetectorError[];
}

/** Where an instance comes from: a device (its worker) or a remote service. */
export interface ResourceSource {
  kind: "device" | "remote";
  /** The device id, or the remote source's id. */
  id: string;
  label: string;
}

/** One resource instance as the server keeps it. */
export interface ResourceInstance {
  /** Stable: "res_" + the first 20 hex digits of sha256(source id, key). */
  id: string;
  key: string;
  type: ResourceTypeId;
  platform: ResourcePlatform;
  name: string;
  source: ResourceSource;
  state: ResourceState;
  /** Why it is unready, offline or gone. */
  stateReason?: string;
  /**
   * Its detector failed on the latest scan: what is shown is the last
   * known report.
   */
  stale?: boolean;
  readiness: ResourceReadiness;
  backends: ResourceBackend[];
  details?: Record<string, string>;
  detector: string;
  discoveredAt: string;
  lastSeenAt: string;
  goneAt?: string;
  /** The live lease on it, when a session holds one. */
  holder?: ResourceHolder;
  /** Sessions waiting for it. */
  queue?: number;
  /**
   * Its device is resetting it after a lease ended; it goes to the next
   * session once the device confirms.
   */
  resetting?: boolean;
}

/**
 * A lease's state. active: its holder session's turn runs (renewed by the
 * turn itself); parked: the turn ended, kept for a while (parkUntil). The
 * rest are ended: released (by the holder, or its turn failed or was
 * canceled), yielded (parked, and another session asked), expired (parked
 * past parkUntil), preempted (another session waited past preemptAt),
 * revoked (the person, the resource gone, its device offline too long).
 */
export type ResourceLeaseState =
  | "active"
  | "parked"
  | "released"
  | "yielded"
  | "expired"
  | "preempted"
  | "revoked";

/** Who holds an instance now, as the inventory lists it. */
export interface ResourceHolder {
  leaseId: string;
  sessionId: string;
  /** The holder session's workspace (to link to it). */
  workspaceId?: string;
  state: ResourceLeaseState;
  since: string;
  parkUntil?: string;
  holdUntil?: string;
  /** When it will be taken for the session waiting. */
  preemptAt?: string;
}

/** One session's exclusive use of one instance. */
export interface ResourceLease {
  id: string;
  resourceId: string;
  /** The device (source) of the resource. */
  sourceId: string;
  /** Raised for every new lease on the instance; stale ones are refused. */
  generation: number;
  holderSessionId: string;
  holderUserId?: string;
  /** The device the holder session runs on. */
  holderDeviceId?: string;
  reason?: string;
  state: ResourceLeaseState;
  acquiredAt: string;
  parkUntil?: string;
  holdUntil?: string;
  contendedSince?: string;
  preemptAt?: string;
  endedAt?: string;
  /** Why it ended, in words. */
  endReason?: string;
  /** Who ended it: the holder, a person's account id, or "foundry". */
  endedBy?: string;
}

/**
 * One operation on a held resource as the audit keeps it: what, by whom,
 * how it went. Typed text is kept as its length; screenshots are never kept.
 */
export interface ResourceOperationRecord {
  id: string;
  leaseId: string;
  resourceId: string;
  sessionId: string;
  op: string;
  /** The arguments, summarized (text as its length). */
  args?: Record<string, unknown>;
  status: "ok" | "error";
  errorCode?: string;
  /** How it went beyond ok/error (ResourceActionResult.outcome). */
  outcome?: Record<string, unknown>;
  startedAt: string;
  durationMs: number;
  bytesOut: number;
}

/** GET /api/resources/{id}/operations: the latest operations, newest first. */
export interface ResourceOperationList {
  operations: ResourceOperationRecord[];
}

/**
 * resource_operate: one operation (or a batch run in order, stopping at the
 * first failure) on an instance a session leases. The worker refuses a
 * generation older than the one it was fenced at.
 */
export interface ResourceOperateRequest {
  resourceId: string;
  key: string;
  type: ResourceTypeId;
  /** The backend to use, e.g. "cua-driver". */
  backend: string;
  leaseId: string;
  generation: number;
  actions: ResourceAction[];
  /** How long the device may take, in milliseconds. */
  deadlineMs: number;
}

/** One typed operation and its arguments. */
export interface ResourceAction {
  op: string;
  args?: Record<string, unknown>;
}

/** An image an operation returned (a screenshot), already scaled. */
export interface ResourceImage {
  /** Base64 of the encoded image. */
  data: string;
  mimeType: string;
  width: number;
  height: number;
  /**
   * Image pixels per screen point: coordinates read from this image are
   * divided by it to address the screen.
   */
  scale: number;
  /** Names this image; coordinate operations may say which one they read. */
  frameId: string;
}

/** The outcome of one action of a resource_operate. */
export interface ResourceActionResult {
  op: string;
  ok: boolean;
  /** What the backend said, as text (JSON or a sentence). */
  text?: string;
  error?: string;
  /** e.g. stale_frame, stale_lease, not_permitted, backend_error. */
  errorCode?: string;
  images?: ResourceImage[];
  /**
   * Facts the audit keeps about how it went (a command's exit code,
   * duration and output sizes); never output itself.
   */
  outcome?: Record<string, unknown>;
}

/** resource_operated: the results of the actions run, in order. */
export interface ResourceOperateResult {
  results: ResourceActionResult[];
  /** The provider session was (re)opened for this request. */
  opened?: boolean;
  /** A failure of the request as a whole (fenced out, no backend). */
  error?: string;
  errorCode?: string;
}

/**
 * resource_reset: fence an instance at generation. Operations of older
 * leases are refused; their provider sessions release held keys and buttons
 * and close. notify, when set, is shown to the person at the device.
 */
export interface ResourceResetRequest {
  resourceId: string;
  key: string;
  type: ResourceTypeId;
  generation: number;
  reason: string;
  notify?: string;
}

/** resource_reset_done: the device fenced and reset the instance. */
export interface ResourceResetResult {
  resourceId: string;
  generation: number;
  error?: string;
}

/**
 * install_resource_backend: install a backend the person chose to install,
 * with its official installer, on this device only.
 */
export interface ResourceBackendInstallRequest {
  backend: string;
}

/** resource_backend_installed: how the install went. */
export interface ResourceBackendInstallResult {
  backend: string;
  ok: boolean;
  /** The installer's last lines of output. */
  output?: string;
  error?: string;
  /** What is still missing before it can be used (e.g. macOS grants). */
  missing?: string[];
}

/**
 * The operations of a computer_use instance (operate_resource). They map one
 * to one onto cua-driver's MCP tools and take its argument names
 * (pid, window_id, element_token, x, y, …): screenshot → get_window_state
 * (with pid) or get_desktop_state; get_ui_tree and find_elements →
 * get_window_state with the accessibility tree; list_apps; list_windows;
 * open_app → launch_app; activate_window → bring_to_front; click;
 * double_click; right_click; type_text; key → press_key; hotkey; scroll;
 * drag; set_value; screen_size → get_screen_size. wait sleeps on the
 * device (ms, at most 5000).
 */
export const computerUseOperations = [
  "select_window",
  "screenshot",
  "get_ui_tree",
  "find_elements",
  "list_apps",
  "list_windows",
  "open_app",
  "activate_window",
  "click",
  "double_click",
  "right_click",
  "type_text",
  "key",
  "hotkey",
  "scroll",
  "drag",
  "set_value",
  "screen_size",
  "wait",
] as const;

export type ComputerUseOperation = (typeof computerUseOperations)[number];

/** The computer-use backend Foundry drives: trycua's cua-driver (MIT). */
export const cuaDriverBackend = "cua-driver";

/**
 * The resources_ops_v1 capability: a worker that declares it in hello runs
 * resource_operate, resource_reset and install_resource_backend.
 */
export const resourceOperationsCapability = "resources_ops_v1";

/** A source of instances and how its last report went. */
export interface ResourceSourceStatus {
  kind: "device" | "remote";
  id: string;
  label: string;
  online: boolean;
  scannerVersion?: number;
  lastReportAt?: string;
  detectorErrors: ResourceDetectorError[];
  /** The device owner allows remote commands (ResourceSourceSettings). */
  allowRemoteCommands: boolean;
}

/**
 * What a device's owner allows sessions to do with its resources
 * (PUT /api/devices/{id}/resources/settings, resource_settings). Kept by the
 * server and enforced by it and by the device's worker.
 */
export interface ResourceSourceSettings {
  /**
   * Sessions the owner started may lease the device's compute resource and
   * run commands on it (in Foundry's scratch folder, or a workspace on the
   * device the session may work in). Off unless the owner turns it on.
   */
  allowRemoteCommands: boolean;
}

/**
 * The operations of a compute instance (operate_resource), run by the
 * device's worker as its own user:
 * - run: a command (argv, or a shell string in command) with cwd under a
 *   scratch folder (scratch, default "default") or a workspace the session
 *   may work in (workspaceId), env additions and timeoutSec (≤ 1800);
 *   answers its exit code and the tails of stdout and stderr (tailBytes
 *   each, ≤ 131072), and saves the whole output to saveOutput when named.
 * - put_files: an upload in base64 pieces (upload, offset, data, done) of a
 *   tar, tar.gz or zip unpacked under dest, or a single file (format
 *   "file") written at dest; 50 MB at most.
 * - get_file: a file's bytes as base64 (offset, length; 25 MB per call).
 * - git_sync: clone or fetch an https git remote (url) into dir of a
 *   scratch folder and check out ref, keeping ignored files (installed
 *   dependencies) for the next run.
 * - cleanup: delete a scratch folder, or a path in it.
 */
export const computeOperations = [
  "run",
  "put_files",
  "get_file",
  "git_sync",
  "cleanup",
] as const;

export type ComputeOperation = (typeof computeOperations)[number];

/** The compute backend: the Foundry worker itself. */
export const computeBackend = "foundry-compute";

/**
 * The resources_compute_v1 capability: a worker that declares it in hello
 * offers a compute instance and takes resource_settings.
 */
export const resourceComputeCapability = "resources_compute_v1";

/** GET /api/resources: instances (gone ones only on request) and sources. */
export interface ResourceList {
  instances: ResourceInstance[];
  sources: ResourceSourceStatus[];
}

/**
 * The resources_v1 capability: a worker that declares it in hello sends
 * resources_report; a server that announces it in registered takes it.
 */
export const resourcesCapability = "resources_v1";
