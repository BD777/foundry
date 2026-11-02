// Daemon configuration: persists the device credential/server URL/workspace path the
// worker uses to reach the Foundry server. Kept separate from transport so
// the HTTP/WS layer doesn't depend on filesystem config concerns.

import { hardenPrivateFile, readJSONFile, writeJSON } from "./storage.js";
import { foundryStatePath } from "./state-root.js";

export interface DaemonConfig {
  pairedAt: string;
  serverURL: string;
  workspacePath: string;
  /** Per-device secret issued by the server at pairing; owner-only on disk. */
  deviceCredential?: string;
}

/** Resolved on use: the state root is read from the environment then. */
export const daemonConfigPath = (): string =>
  foundryStatePath("daemon-config.json");

let hardened = false;

/**
 * Read on every daemon request, so the file is made owner-only once per
 * process (a config from before that rule); writes keep it owner-only.
 */
export function readDaemonConfig(): DaemonConfig | undefined {
  const path = daemonConfigPath();
  const config = readJSONFile<DaemonConfig>(path);
  if (config && !hardened) {
    hardenPrivateFile(path);
    hardened = true;
  }
  return config;
}

export function writeDaemonConfig(config: DaemonConfig): void {
  writeJSON(daemonConfigPath(), config);
}
