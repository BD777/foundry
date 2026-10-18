/**
 * Several people on one computer account (docs/devices-and-workspaces.md,
 * "一台电脑上的几个人"). One system account belongs to one owner by default;
 * a second person pairing a worker that runs under the same account is told
 * that they would share it, and only pairs after they choose to. Nothing
 * here isolates anyone: these records say who shares, they keep nothing
 * apart. Mirrored by apps/server/internal/store/device_sharing.go.
 */

/**
 * Another person's device that runs under the same system account of the
 * same computer as this one. Only this device's owner sees it
 * (DeviceProjection.sharesSystemAccountWith).
 */
export interface DeviceAccountShare {
  deviceId: string;
  deviceLabel: string;
  /** The other device's owner, by display name. */
  ownerName: string;
  /**
   * When pairing the later of the two devices someone chose to share;
   * absent when Foundry found the shared account later (devices paired
   * before it checked).
   */
  acceptedAt?: string;
  /** Who chose to share, by display name. */
  acceptedBy?: string;
  /**
   * Set on the device that was there first until its owner dismissed the
   * notice that someone else now shares its account.
   */
  noticePending?: boolean;
}

/**
 * Where a pairing token stands (POST /api/devices/pairing-tokens/status,
 * the token's creator only). "needs_consent": a worker tried to pair under
 * a system account another person's device already uses, and waits for the
 * person to continue or cancel (in the web or in the terminal).
 */
export type DevicePairingState =
  "waiting" | "needs_consent" | "paired" | "cancelled" | "expired";

export interface DevicePairingStatus {
  state: DevicePairingState;
  /** "needs_consent": the people whose devices use that account. */
  sharedWith?: string[];
  /** "paired": the device it became. */
  deviceId?: string;
}

/** POST /api/devices/pairing-tokens/status. */
export interface DevicePairingStatusRequest {
  token: string;
}

/**
 * POST /api/devices/pairing-tokens/consent: continue (share the account)
 * or cancel the pairing waiting on the token.
 */
export interface DevicePairingConsentRequest {
  token: string;
  accept: boolean;
}

/**
 * The answer of POST /api/daemon/pair when the worker's system account is
 * already used by another person's device (HTTP 409). Nothing was paired
 * and the token is still good: send the pairing again with
 * acceptSharedAccount, or wait for the person to continue in the web.
 */
export interface DevicePairingConsentNeeded {
  error: string;
  code: "system_account_shared";
  sharedWith: string[];
}

/** The daemon_pair failure code for DevicePairingConsentNeeded. */
export const systemAccountSharedCode = "system_account_shared";

/**
 * The device_sharing capability: the worker takes device_sharing
 * (DeviceSharingPayload), which the server sends after hello and whenever
 * the people sharing the device's system account change, and tells its
 * sessions that the account is shared.
 */
export const deviceSharingCapability = "device_sharing";

/** device_sharing: who else uses this device's system account. */
export interface DeviceSharingPayload {
  /** Display names of the other people; empty when nobody shares it. */
  sharedWith: string[];
}
