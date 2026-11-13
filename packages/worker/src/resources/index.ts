// Resources module: what this device offers sessions, found by detectors
// (detector.ts, detectors/) and reported to the server by the scanner
// (scanner.ts). The composition root attaches the scanner to a server
// connection that takes resources_report; everything else imports from
// here.

export {
  detectorName,
  maxDetectorTimeoutMs,
  resourcePlatform,
  runDetector,
  type DetectContext,
  type DetectedInstance,
  type Detector,
  type DetectorOutcome,
  type DeviceResource,
} from "./detector.js";
export { execBounded, findOnPath, type ExecResult } from "./exec.js";
export { builtinDetectors } from "./detectors/index.js";
export {
  ResourceScanner,
  scannerVersion,
  type ScannerAttachment,
  type ScannerOptions,
} from "./scanner.js";
export { discoverBrowsers } from "./detectors/browser.js";
export {
  ProviderError,
  ProviderRegistry,
  type ProviderLease,
  type ProviderSession,
  type ResourceProvider,
} from "./provider.js";
export {
  ResourceOperations,
  macNotification,
  type ResourceOperationsOptions,
} from "./operations.js";
export {
  createCuaDriverProvider,
  mapComputerUseAction,
  type CuaDriverProviderOptions,
  type ImageEncoder,
} from "./providers/cua-driver.js";
export { McpStdioClient } from "./providers/mcp-stdio.js";
export {
  createComputeProvider,
  removeIdleSessionScratches,
  type ComputeProvider,
  type ComputeProviderOptions,
} from "./providers/compute.js";
export { ResourceSettingsStore, resourceSettings } from "./compute-settings.js";
export { computeDetector, createComputeDetector } from "./detectors/compute.js";
export { unpackArchive, ArchiveError } from "./archive.js";
export {
  cuaDriverEnv,
  cuaDriverGrantRun,
  cuaDriverLeasePrepareRequest,
  cuaDriverPermissionWatchActive,
  cuaDriverSettingsPanes,
  isCuaDriverSettingsPane,
  openCuaDriverSettings,
  prepareCuaDriverForLease,
  requestCuaDriverAccess,
  stopCuaDriverPermissionWatch,
  watchCuaDriverPermissions,
  type CuaDriverLeasePreparation,
  type CuaDriverSettingsPane,
  resetCuaDriverGrantRun,
  resolveCuaDriverBinary,
  type CuaDriverGrantRun,
} from "./cua-driver-host.js";
export {
  createCuaDriverDetector,
  cuaDriverGrantDetailKeys,
  cuaDriverScreenControlDetector,
} from "./detectors/computer-use-cua-driver.js";
export {
  parseCuaDriverPermissions,
  type CuaDriverGrants,
  type CuaDriverPermissions,
} from "./cua-driver-permissions.js";
export { installResourceBackend, type InstallOptions } from "./install.js";
export {
  discoverComputerUse,
  macControlGrants,
  requestMacWorkerAccess,
  type MacControlGrants,
} from "./detectors/computer-use-macos.js";
