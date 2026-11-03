import { statSync } from "node:fs";
import { foundryStatePath } from "../platform/state-root.js";
import {
  tryReadJSONFile,
  writePrivateJSONAtomic,
} from "../platform/storage.js";

/**
 * The model providers connector extensions give this device
 * (docs/connector-extensions.md, "模型接入"), as the connectors module last
 * listed them (connectors/extensions/model-access.ts). Kept in a private
 * file, so the device's profiles read them at once and a worker restart
 * keeps them until the extension answers again.
 */

export interface ConnectorModelProvider {
  id: string;
  label: string;
  runtime: "claude";
  model: string;
  models: string[];
  /** Key order is the check fingerprint's (profiles.ts profileFingerprint). */
  externalConnection: { executable: string; args: string[]; identity: string };
  connector: { kind: string; label: string; extensionId: string };
}

interface ProvidersFile {
  providers?: ConnectorModelProvider[];
}

export function connectorModelProvidersPath(): string {
  return foundryStatePath("extension-model-providers.json");
}

let cache:
  { revision: string; providers: ConnectorModelProvider[] } | undefined;

function revisionOf(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "none";
  }
}

/** The providers as last listed. */
export function connectorModelProviders(): ConnectorModelProvider[] {
  const revision = revisionOf(connectorModelProvidersPath());
  if (cache?.revision !== revision)
    cache = {
      revision,
      providers:
        tryReadJSONFile<ProvidersFile>(connectorModelProvidersPath())
          ?.providers ?? [],
    };
  return cache.providers;
}

/** Replaces the list; false when it was already the same. */
export function saveConnectorModelProviders(
  providers: ConnectorModelProvider[],
): boolean {
  if (JSON.stringify(providers) === JSON.stringify(connectorModelProviders()))
    return false;
  writePrivateJSONAtomic(connectorModelProvidersPath(), { providers });
  return true;
}
