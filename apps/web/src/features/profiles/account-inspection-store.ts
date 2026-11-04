import { useEffect, useSyncExternalStore } from "react";
import type { NativeAccountInspection } from "@bd777/foundry-protocol";
import { inspectDeviceAccount } from "../../api";
import { i18n } from "../../i18n";

type Runtime = "claude" | "codex";

// Per device/runtime inspection memory. It deliberately lives for the page
// session rather than in component state: collapsing the account row or
// switching the official-accounts tab unmounts the panel, and the selected
// configuration (plus its last verified read) must survive that. Nothing here
// changes the execution configuration; this is inspection-only state.
export interface InspectionSnapshot {
  initialized: boolean;
  selectedSource?: string;
  results: Readonly<Record<string, NativeAccountInspection>>;
  /**
   * Authoritative configuration identity, taken only from the latest ACCEPTED
   * response (the seq-matched one). Never reconstructed from cached results:
   * two reads can share the same checkedAt second while carrying different
   * source lists (a config directory appearing/disappearing), so timestamp
   * ordering would pick the wrong directory set and hide the fallback entry.
   */
  sources: readonly string[];
  executionSource: string;
  /** In-flight request target; "" means the worker's default (execution) source. */
  loadingSource?: string;
  errors: Readonly<Record<string, string>>;
  /** Accepted reads so far; each one also refreshed the device's agents. */
  accepted: number;
}

interface Entry extends InspectionSnapshot {
  seq: number;
  view: InspectionSnapshot;
}

const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();

function entryFor(key: string): Entry {
  let entry = entries.get(key);
  if (!entry) {
    entry = {
      initialized: false,
      results: {},
      sources: [],
      executionSource: "",
      errors: {},
      accepted: 0,
      seq: 0,
      view: {
        initialized: false,
        results: {},
        sources: [],
        executionSource: "",
        errors: {},
        accepted: 0,
      },
    };
    entries.set(key, entry);
  }
  return entry;
}

function publish(key: string) {
  const entry = entryFor(key);
  entry.view = {
    initialized: entry.initialized,
    selectedSource: entry.selectedSource,
    results: entry.results,
    sources: entry.sources,
    executionSource: entry.executionSource,
    loadingSource: entry.loadingSource,
    errors: entry.errors,
    accepted: entry.accepted,
  };
  listeners.get(key)?.forEach((listener) => listener());
}

function subscribe(key: string, listener: () => void) {
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(listener);
  return () => set!.delete(listener);
}

// One monotonic sequence per key: a late response from an earlier selection is
// dropped entirely, so it can never overwrite the configuration now in view.
async function request(
  key: string,
  deviceId: string,
  runtime: Runtime,
  source: string | undefined,
) {
  const entry = entryFor(key);
  const target = source ?? "";
  if (entry.loadingSource === target) return;
  const seq = ++entry.seq;
  if (entry.errors[target]) {
    const errors = { ...entry.errors };
    delete errors[target];
    entry.errors = errors;
  }
  entry.loadingSource = target;
  publish(key);
  try {
    const result = await inspectDeviceAccount(deviceId, runtime, source);
    const current = entryFor(key);
    if (current.seq !== seq) return;
    // The accepted response is the only authoritative configuration identity.
    // Its sources list reflects what the device has RIGHT NOW; replacing it
    // atomically keeps sourceMissing/executionSource consistent even when
    // older cached reads carry a different list with the same timestamp.
    current.sources = result.sources;
    current.executionSource = result.executionSource;
    current.results = { ...current.results, [result.source]: result };
    if (current.errors[result.source]) {
      const errors = { ...current.errors };
      delete errors[result.source];
      current.errors = errors;
    }
    current.accepted += 1;
    if (current.loadingSource === target) current.loadingSource = undefined;
    publish(key);
  } catch (cause) {
    const current = entryFor(key);
    if (current.seq !== seq) return;
    current.errors = {
      ...current.errors,
      [target]:
        cause instanceof Error && cause.message
          ? cause.message
          : i18n.t("profiles:inspection.checkFailed"),
    };
    if (current.loadingSource === target) current.loadingSource = undefined;
    publish(key);
  }
}

function keyOf(deviceId: string, runtime: Runtime, identity = "") {
  return `${deviceId}\u0000${runtime}\u0000${identity}`;
}

export function useDeviceAccountInspection(
  deviceId: string,
  runtime: Runtime,
  online: boolean,
  identity?: string,
): InspectionSnapshot {
  const key = keyOf(deviceId, runtime, identity);
  const snapshot = useSyncExternalStore(
    (listener) => subscribe(key, listener),
    () => entryFor(key).view,
  );
  // The automatic check runs at most once per page session. Re-mounting the
  // panel (collapse/tab switch) restores the stored read instead of resetting
  // to the worker's default source and issuing another request.
  useEffect(() => {
    if (!online) return;
    const entry = entryFor(key);
    if (entry.initialized) return;
    entry.initialized = true;
    void request(key, deviceId, runtime, undefined);
  }, [deviceId, key, online, runtime]);
  return snapshot;
}

export function checkInspection(
  deviceId: string,
  runtime: Runtime,
  source?: string,
  identity?: string,
) {
  void request(keyOf(deviceId, runtime, identity), deviceId, runtime, source);
}

export function selectInspectionSource(
  deviceId: string,
  runtime: Runtime,
  source: string,
  identity?: string,
) {
  const key = keyOf(deviceId, runtime, identity);
  const entry = entryFor(key);
  entry.selectedSource = source;
  publish(key);
  void request(key, deviceId, runtime, source);
}

export function resetInspectionSource(
  deviceId: string,
  runtime: Runtime,
  source: string,
  identity?: string,
) {
  const key = keyOf(deviceId, runtime, identity);
  entryFor(key).selectedSource = source;
  publish(key);
}
