// Resources module: what this device offers sessions, found by detectors
// (detector.ts, detectors/) and reported to the server by the scanner
// (scanner.ts). The composition root attaches the scanner to a server
// connection that takes resources_report; everything else imports from
// here.
//
// discoverResources is the older, synchronous view (browsers and the
// worker's own macOS screen control) that registrations and session notes
// still use until those move onto the inventory.

import type { DeviceResource } from "@bd777/foundry-protocol";
import { discoverBrowsers } from "./detectors/browser.js";
import { discoverComputerUse } from "./detectors/computer-use-macos.js";

export {
  detectorName,
  maxDetectorTimeoutMs,
  resourcePlatform,
  runDetector,
  type DetectContext,
  type DetectedInstance,
  type Detector,
  type DetectorOutcome,
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
  type ComputeProvider,
  type ComputeProviderOptions,
} from "./providers/compute.js";
export { ResourceSettingsStore, resourceSettings } from "./compute-settings.js";
export { computeDetector, createComputeDetector } from "./detectors/compute.js";
export { unpackArchive, ArchiveError } from "./archive.js";
export {
  cuaDriverEnv,
  cuaDriverGrantRun,
  cuaDriverPermissionWatchActive,
  cuaDriverSettingsPanes,
  isCuaDriverSettingsPane,
  openCuaDriverSettings,
  requestCuaDriverAccess,
  stopCuaDriverPermissionWatch,
  watchCuaDriverPermissions,
  type CuaDriverSettingsPane,
  resetCuaDriverGrantRun,
  resolveCuaDriverBinary,
  type CuaDriverGrantRun,
} from "./cua-driver-host.js";
export {
  createCuaDriverDetector,
  cuaDriverGrantDetailKeys,
  cuaDriverScreenControlDetector,
  parseCuaDriverPermissions,
} from "./detectors/computer-use-cua-driver.js";
export { installResourceBackend, type InstallOptions } from "./install.js";
export {
  discoverComputerUse,
  macControlGrants,
  requestResourceAccess,
  type MacControlGrants,
} from "./detectors/computer-use-macos.js";

/** Everything this device offers sessions right now (the older view). */
export function discoverResources(): DeviceResource[] {
  return [...discoverBrowsers(), ...discoverComputerUse()];
}
