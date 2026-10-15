import { existsSync, readFileSync, rmSync } from "node:fs";
import { readDaemonConfig, writeDaemonConfig } from "../config.js";
import { devicePath, getDevice } from "../device.js";
import { prepareExplicitRepair } from "../device-removal.js";
import { pairWithConsent } from "../pairing-consent.js";
import { syncReviews } from "../issues.js";
import { registerExecutionWorkspace } from "../repository-registry.js";
import {
  installService,
  serviceLogPaths,
  status,
  type ServiceHost,
} from "../service.js";
import { ensureServerReachable } from "../server-http.js";
import { optionEnabled, optionValue } from "../utils.js";
import {
  explicitWorkspacePath,
  registerDaemon,
  serverURLFromArgs,
  workspacePathFromArgs,
} from "../workspace-ops.js";
import { initWorkspace, readWorkspace, writeRegistry } from "../workspaces.js";

/**
 * prepareExplicitPair is the only path that clears a device-removal marker.
 * It is invoked by the user-run pair/setup commands, never by the automatic
 * service. The device identity rotates so the machine registers as a new
 * device instead of colliding with the tombstone.
 */
function prepareExplicitPair(): void {
  if (!prepareExplicitRepair()) {
    return;
  }
  rmSync(devicePath, { force: true });
  console.log(
    "This machine had been removed from its Foundry server. Registering it as a new device.",
  );
}

/**
 * Exchanges --token for this device's credential; an existing credential for
 * the same server is kept otherwise, so re-running setup needs no new token.
 * FOUNDRY_PAIRING_TOKEN (containers) is used only while unpaired: the token
 * is single-use but the variable survives restarts.
 */
async function pairWithServer(
  args: string[],
  serverURL: string,
  workspacePath: string,
): Promise<void> {
  const existing = readDaemonConfig();
  const paired = Boolean(
    existing?.deviceCredential && existing.serverURL === serverURL,
  );
  const token =
    optionValue(args, "--token") ??
    (paired ? undefined : process.env.FOUNDRY_PAIRING_TOKEN?.trim());
  if (!token) {
    if (existing && paired) {
      writeDaemonConfig({ ...existing, workspacePath });
      return;
    }
    throw new Error(
      "A pairing token is required. In the Foundry web app open Devices → Add device and pass it with --token.",
    );
  }
  const previousDeviceId = getDevice().id;
  const { deviceId, credential } = await pairWithConsent(serverURL, token, {
    shareSystemAccount: optionEnabled(args, "--share-system-account"),
  });
  // A new device starts with no workspaces: registrations this machine kept
  // for the device it was before belong to that device, not to this one. The
  // folders themselves are left as they are.
  if (deviceId !== previousDeviceId) writeRegistry([]);
  writeDaemonConfig({
    pairedAt: new Date().toISOString(),
    deviceCredential: credential,
    serverURL,
    workspacePath,
  });
  console.log(`Paired this machine as ${deviceId}.`);
}

export async function pair(args: string[]): Promise<void> {
  const serverURL = serverURLFromArgs(args);
  const workspacePath = explicitWorkspacePath(args);
  prepareExplicitPair();
  await pairWithServer(args, serverURL, workspacePath);
  await registerDaemon(serverURL, workspacePath);
  console.log(
    workspacePath
      ? `Paired ${workspacePath} with ${serverURL}`
      : `Paired this device with ${serverURL}; add workspaces from the Workspaces page.`,
  );
  console.log(
    "Run foundry-worker install-service to start this daemon at login.",
  );
}

export async function setup(
  args: string[],
  host: ServiceHost = {},
): Promise<void> {
  const serverURL = serverURLFromArgs(args);
  // A device is set up without a workspace unless one is passed; people add
  // them later from the Workspaces page.
  const workspacePath = explicitWorkspacePath(args);
  const noService = optionEnabled(args, "--no-service");
  const noStart = optionEnabled(args, "--no-start");

  console.log("Setting up Foundry local daemon...");
  await ensureServerReachable(serverURL);
  prepareExplicitPair();
  // Paired first: pairing as a new device clears the workspaces registered
  // for an earlier one, and must not clear the one passed here.
  await pairWithServer(args, serverURL, workspacePath);
  if (workspacePath) {
    initWorkspace(workspacePath);
    await registerExecutionWorkspace(
      workspacePath,
      readWorkspace(workspacePath).id,
    );
  }
  await registerDaemon(serverURL, workspacePath);

  // Not running is only news when the person asked for it to start.
  let started = true;
  if (noService) {
    console.log("Service installation skipped (--no-service).");
  } else {
    started = installService(noStart ? ["--no-start"] : [], host) || noStart;
  }

  console.log("");
  status();
  console.log("");
  console.log(
    started
      ? "Foundry daemon setup complete."
      : "Foundry is set up, but the worker is not running yet; start it as shown above.",
  );
}

export function logs(args: string[]): void {
  const lines = Number(optionValue(args, "--lines", "80"));
  const paths = serviceLogPaths();
  for (const [label, path] of [
    ["stdout", paths.out],
    ["stderr", paths.err],
  ] as const) {
    console.log(`== ${label}: ${path} ==`);
    if (!existsSync(path)) {
      console.log("(no log file)");
      continue;
    }
    const text = readFileSync(path, "utf8").split("\n");
    console.log(text.slice(Math.max(0, text.length - lines - 1)).join("\n"));
  }
}

export async function sync(args: string[]): Promise<void> {
  const serverURL = serverURLFromArgs(args);
  const workspacePath = workspacePathFromArgs(args);
  await syncReviews(serverURL, workspacePath);
}
