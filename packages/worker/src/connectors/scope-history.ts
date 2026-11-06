import { readFileSync } from "node:fs";
import type { ConnectorScopeChange } from "@bd777/foundry-protocol";
import { foundryStatePath } from "../platform/state-root.js";
import { writePrivateJSONAtomic } from "../platform/storage.js";

/**
 * The granted scopes this device last read per connector and authorization
 * group, and the latest change of them (DEV-136): Connectors says whether
 * Foundry made a change or the tool's own login changed without it. Only
 * scope names are kept, never a credential.
 */
interface Entry {
  scopes: string[];
  change?: ConnectorScopeChange;
  /** Foundry ran an authorization or sign-in; the next change is its. */
  foundryAt?: string;
}

const foundryWindowMs = 30 * 60_000;
const historyPath = () => foundryStatePath("connectors", "scope-history.json");

function load(): Record<string, Entry> {
  try {
    const parsed = JSON.parse(readFileSync(historyPath(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

const key = (kind: string, group: string) => `${kind}/${group}`;

/** Foundry is about to change these groups' scopes (an authorization or a sign-in). */
export function expectFoundryChange(
  kind: string,
  groups: string[],
  now = new Date(),
): void {
  const history = load();
  for (const group of groups)
    history[key(kind, group)] = {
      scopes: history[key(kind, group)]?.scopes ?? [],
      ...history[key(kind, group)],
      foundryAt: now.toISOString(),
    };
  writePrivateJSONAtomic(historyPath(), history);
}

/**
 * Records a reading and returns the latest change. The first reading of a
 * group is the baseline: nothing is said to have changed.
 */
export function noteGrantedScopes(
  kind: string,
  group: string,
  granted: string[],
  now = new Date(),
): ConnectorScopeChange | undefined {
  const history = load();
  const entry = history[key(kind, group)];
  const scopes = [...new Set(granted)].sort();
  if (!entry || (!entry.scopes.length && !entry.change && !entry.foundryAt)) {
    history[key(kind, group)] = { scopes };
    writePrivateJSONAtomic(historyPath(), history);
    return undefined;
  }
  const added = scopes.filter((scope) => !entry.scopes.includes(scope));
  const removed = entry.scopes.filter((scope) => !scopes.includes(scope));
  if (!added.length && !removed.length) return entry.change;
  const byFoundry =
    !!entry.foundryAt &&
    now.getTime() - Date.parse(entry.foundryAt) < foundryWindowMs;
  const change: ConnectorScopeChange = {
    source: byFoundry ? "foundry" : "outside",
    at: now.toISOString(),
    added,
    removed,
  };
  history[key(kind, group)] = { scopes, change };
  writePrivateJSONAtomic(historyPath(), history);
  return change;
}
