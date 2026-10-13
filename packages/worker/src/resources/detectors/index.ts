// The detectors a worker runs, one or more per resource type.

import type { Detector } from "../detector.js";
import { accountDetector } from "./account.js";
import { browserDetector } from "./browser.js";
import { computeDetector } from "./compute.js";
import { cuaDriverScreenControlDetector } from "./computer-use-cua-driver.js";
import { macWorkerScreenControlDetector } from "./computer-use-macos.js";
import { containerRuntimeDetector } from "./container-runtime.js";
import { diskDetector } from "./disk.js";
import { gpuDetector } from "./gpu.js";
import { androidDeviceDetector, appleDeviceDetector } from "./mobile-device.js";
import { androidEmulatorDetector, iosSimulatorDetector } from "./simulator.js";
import { toolchainDetector } from "./toolchain.js";

export const builtinDetectors: readonly Detector[] = [
  browserDetector,
  macWorkerScreenControlDetector,
  cuaDriverScreenControlDetector,
  iosSimulatorDetector,
  androidEmulatorDetector,
  androidDeviceDetector,
  appleDeviceDetector,
  gpuDetector,
  containerRuntimeDetector,
  toolchainDetector,
  accountDetector,
  diskDetector,
  computeDetector,
];
