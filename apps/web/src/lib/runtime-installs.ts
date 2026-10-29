import { useSyncExternalStore } from "react";
import type { NativeCliInstallResult } from "@bd777/foundry-protocol";
import { installDeviceCli } from "../api";
import { serverErrorText } from "./errors";
import {
  runtimeInstallKey,
  type AgentRuntime,
  type RuntimeInstallActivity,
} from "./device-readiness";

/**
 * Installs started from this page, for every surface at once: the chat
 * picker, the Model providers page and the device page show the same run.
 * The worker also reports a running install to every page, so this only
 * bridges the moments before its report arrives and keeps the answer.
 */
let installs: ReadonlyMap<string, RuntimeInstallActivity> = new Map();
const listeners = new Set<() => void>();
const running = new Map<string, Promise<NativeCliInstallResult | undefined>>();

function set(key: string, value: RuntimeInstallActivity): void {
  installs = new Map(installs).set(key, value);
  for (const listener of listeners) listener();
}

/**
 * Install (or update) a runtime on a device. A second request for one that
 * is running joins it. Resolves with the worker's answer, or undefined when
 * the request itself failed; the failure is kept for the page to show.
 */
export function installRuntime(
  deviceId: string,
  runtime: AgentRuntime,
): Promise<NativeCliInstallResult | undefined> {
  const key = runtimeInstallKey(deviceId, runtime);
  const current = running.get(key);
  if (current) return current;
  const startedAt = Date.now();
  set(key, { state: "running", startedAt });
  const work = installDeviceCli(deviceId, runtime)
    .then((result) => {
      set(key, {
        state: result.ok ? "succeeded" : "failed",
        startedAt,
        // The worker's own one-line reason, else the output's last line.
        detail: result.ok
          ? undefined
          : ((result.cli?.update?.state === "failed"
              ? result.cli.update.detail
              : undefined) ?? lastLine(result.log)),
        log: result.log,
        cli: result.cli,
      });
      return result;
    })
    .catch((cause: unknown) => {
      set(key, { state: "failed", startedAt, detail: serverErrorText(cause) });
      return undefined;
    })
    .finally(() => running.delete(key));
  running.set(key, work);
  return work;
}

/** The last meaningful line of an installer's output, as its reason. */
function lastLine(log: string): string | undefined {
  return log
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Every install this page started, keyed by `runtimeInstallKey`. */
export function useRuntimeInstalls(): ReadonlyMap<
  string,
  RuntimeInstallActivity
> {
  return useSyncExternalStore(
    subscribe,
    () => installs,
    () => installs,
  );
}
