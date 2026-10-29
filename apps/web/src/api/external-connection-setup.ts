import type {
  ExternalConnectionOffersResponse,
  ExternalConnectionSetupDetail,
  ExternalConnectionSetupRun,
} from "@bd777/foundry-protocol";
import { request } from "./http";

// Setting an external connection up on a device (docs/external-connections.md,
// "Setup on another device"). Every call is the device owner's.

const setupsPath = (deviceId: string) =>
  `/api/devices/${encodeURIComponent(deviceId)}/external-connection-setups`;

/** The connections offered for a device, with where each stands there. */
export function listExternalConnectionOffers(
  deviceId: string,
): Promise<ExternalConnectionOffersResponse> {
  return request("GET", setupsPath(deviceId));
}

/** One connection's setup on the device, read from it now when online. */
export function getExternalConnectionSetup(
  deviceId: string,
  profileId: string,
  run?: { runId: string; after: number },
): Promise<ExternalConnectionSetupDetail> {
  const query = run
    ? `?runId=${encodeURIComponent(run.runId)}&after=${run.after}`
    : "";
  return request(
    "GET",
    `${setupsPath(deviceId)}/${encodeURIComponent(profileId)}${query}`,
  );
}

/**
 * Runs the setup command the person was shown (named by its digest) on the
 * device. The server refuses if the registered command changed since.
 */
export function startExternalConnectionSetup(
  deviceId: string,
  profileId: string,
  digest: string,
): Promise<{ run: ExternalConnectionSetupRun }> {
  return request(
    "POST",
    `${setupsPath(deviceId)}/${encodeURIComponent(profileId)}/run`,
    { body: { digest } },
  );
}

export function cancelExternalConnectionSetup(
  deviceId: string,
  profileId: string,
  runId: string,
): Promise<{ run: ExternalConnectionSetupRun }> {
  return request(
    "DELETE",
    `${setupsPath(deviceId)}/${encodeURIComponent(profileId)}/run?runId=${encodeURIComponent(runId)}`,
  );
}
