import type { ProfileAuthorization } from "@foundry/protocol";
import {
  completeProfileAuthorization,
  startProfileAuthorization,
} from "../api";

/**
 * Authorization always targets one device: the agent CLI login runs there and
 * only the page URL, the one-time code and the status travel back, so every
 * caller has to name the device it is configuring.
 */
export function startAuthorizationOnDevice(
  deviceId: string,
  profileId: string,
): Promise<ProfileAuthorization> {
  return startProfileAuthorization(profileId, { deviceId });
}

/**
 * `onCompleted` runs only when the CLI reports the login landed, which is the
 * moment the profile's status in the control plane changes and the caller has
 * to reload its projections.
 */
export async function completeAuthorizationOnDevice(
  deviceId: string,
  profileId: string,
  authorizationId: string,
  authorizationResult?: string,
  onCompleted?: () => Promise<void>,
): Promise<ProfileAuthorization> {
  const authorization = await completeProfileAuthorization(
    profileId,
    authorizationId,
    { authorizationResult, deviceId },
  );
  if (authorization.status === "completed") await onCompleted?.();
  return authorization;
}
