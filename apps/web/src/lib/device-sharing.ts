import type {
  DeviceAccountShare,
  DeviceProjection,
} from "@bd777/foundry-protocol";

/**
 * Other people's devices under the same system account of the same computer
 * (DeviceProjection.sharesSystemAccountWith, only its owner sees them).
 * Sharing is a choice someone made, never isolation: these helpers only
 * name who shares.
 */
type SharedDevice = Pick<DeviceProjection, "sharesSystemAccountWith">;

/** The people sharing the device's system account, each once. */
export function accountSharers(device: SharedDevice | undefined): string[] {
  return [
    ...new Set(
      (device?.sharesSystemAccountWith ?? []).map((share) => share.ownerName),
    ),
  ];
}

export function sharesSystemAccount(device: SharedDevice | undefined): boolean {
  return accountSharers(device).length > 0;
}

/** "Ann", "Ann and Bo", "Ann, Bo, and Cy" in the reader's language. */
export function joinNames(names: readonly string[], language: string): string {
  return new Intl.ListFormat(language, {
    style: "long",
    type: "conjunction",
  }).format(names);
}

/**
 * When the sharing began and who chose it: the earliest share someone
 * accepted while pairing. Undefined when Foundry only noticed it later.
 */
export function firstAcceptedShare(
  device: SharedDevice | undefined,
): DeviceAccountShare | undefined {
  return (device?.sharesSystemAccountWith ?? [])
    .filter((share) => share.acceptedAt)
    .sort((a, b) => Date.parse(a.acceptedAt!) - Date.parse(b.acceptedAt!))[0];
}

/**
 * The owner who was there first has not yet read that someone else now
 * shares the device's system account: the device with those people.
 */
export interface AccountShareNotice {
  device: DeviceProjection;
  names: string[];
}

export function pendingAccountShareNotices(
  devices: readonly DeviceProjection[],
): AccountShareNotice[] {
  return devices.flatMap((device) => {
    const names = accountSharers({
      sharesSystemAccountWith: device.sharesSystemAccountWith?.filter(
        (share) => share.noticePending,
      ),
    });
    return names.length ? [{ device, names }] : [];
  });
}

/**
 * Where a new assistant should live when the server suggests nothing: an
 * online computer nobody else shares, then any one nobody shares. Never a
 * shared one: the person picks that themselves.
 */
export function preferUnsharedDevice<T extends DeviceProjection>(
  devices: readonly T[],
): T | undefined {
  const unshared = devices.filter((device) => !sharesSystemAccount(device));
  return (
    unshared.find((device) => device.status === "connected") ?? unshared[0]
  );
}
