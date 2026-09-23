// Daemon configuration: persists the device credential/server URL/workspace path the
// worker uses to reach the Foundry server. Kept separate from transport so
// the HTTP/WS layer doesn't depend on filesystem config concerns.

import { existsSync, readFileSync } from "node:fs";
import { hardenPrivateFile, writeJSON } from "./storage.js";
import { foundryStatePath } from "./state-root.js";

export interface DaemonConfig {
  pairedAt: string;
  serverURL: string;
  workspacePath: string;
  /** Per-device secret issued by the server at pairing; owner-only on disk. */
  deviceCredential?: string;
}

export const daemonConfigPath = foundryStatePath("daemon-config.json");

export function readDaemonConfig(): DaemonConfig | undefined {
  if (!existsSync(daemonConfigPath)) {
    return undefined;
  }
  hardenPrivateFile(daemonConfigPath);
  return JSON.parse(readFileSync(daemonConfigPath, "utf8")) as DaemonConfig;
}

export function writeDaemonConfig(config: DaemonConfig): void {
  writeJSON(daemonConfigPath, config);
}
