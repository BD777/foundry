import { useSyncExternalStore } from "react";
import type { DeviceConnectorState } from "@bd777/foundry-protocol";
import { checkDeviceConnector, installDeviceConnector } from "../../api";
import { serverErrorText } from "../../lib/errors";

/** A connector install this page started on one device. */
export interface ConnectorInstall {
  state: "running" | "failed" | "succeeded";
  startedAt: number;
  /** Why it failed, in the device's words. */
  detail?: string;
  /** The device's reading once it finished. */
  result?: DeviceConnectorState;
}

/**
 * Installs started from the Connectors pages, kept for every surface and
 * across tab switches: a row shows the same run wherever it is drawn, and
 * a second click joins the run instead of starting another.
 */
let installs: ReadonlyMap<string, ConnectorInstall> = new Map();
const listeners = new Set<() => void>();
const running = new Map<string, Promise<DeviceConnectorState | undefined>>();

export function connectorInstallKey(deviceId: string, kind: string): string {
  return `${deviceId}:${kind}`;
}

function set(key: string, value: ConnectorInstall): void {
  installs = new Map(installs).set(key, value);
  for (const listener of listeners) listener();
}

const failedOnDevice = / on the device failed: /;
const pollMs = 5_000;
const pollLimitMs = 12 * 60_000;

/** The device's own reason, without the server's "Installing … failed:". */
function reasonOf(cause: unknown): string {
  return serverErrorText(cause).replace(
    /^Installing .+? on the device failed: /,
    "",
  );
}

/**
 * A proxy can end a long request while the device keeps installing; then
 * the device's next reading is the answer. Its connector stays busy until
 * the install ends, so read again until it is not.
 */
async function settle(
  deviceId: string,
  kind: string,
  startedAt: number,
): Promise<DeviceConnectorState> {
  for (;;) {
    try {
      return await checkDeviceConnector(deviceId, kind);
    } catch (cause) {
      if (
        !/connector_busy/.test(serverErrorText(cause)) ||
        Date.now() - startedAt > pollLimitMs
      )
        throw cause;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}

/**
 * Installs (or updates) a connector's tool on a device. Resolves with the
 * device's reading, or undefined when it failed; the outcome is kept for
 * the row to show either way.
 */
export function installConnector(
  deviceId: string,
  kind: string,
): Promise<DeviceConnectorState | undefined> {
  const key = connectorInstallKey(deviceId, kind);
  const current = running.get(key);
  if (current) return current;
  const startedAt = Date.now();
  set(key, { state: "running", startedAt });
  const work = installDeviceConnector(deviceId, kind)
    .catch(async (cause: unknown) => {
      const text = serverErrorText(cause);
      if (failedOnDevice.test(text) && !/connector_busy/.test(text))
        throw cause;
      const state = await settle(deviceId, kind, startedAt);
      if (state.status === "not_installed") throw cause;
      return state;
    })
    .then((result) => {
      set(key, { state: "succeeded", startedAt, result });
      return result;
    })
    .catch((cause: unknown) => {
      set(key, { state: "failed", startedAt, detail: reasonOf(cause) });
      return undefined;
    })
    .finally(() => running.delete(key));
  running.set(key, work);
  return work;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Every install the Connectors pages started, by `connectorInstallKey`. */
export function useConnectorInstalls(): ReadonlyMap<string, ConnectorInstall> {
  return useSyncExternalStore(
    subscribe,
    () => installs,
    () => installs,
  );
}
