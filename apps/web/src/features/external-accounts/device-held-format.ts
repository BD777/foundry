import type {
  ConnectorDescriptor,
  DeviceConnectorDevice,
  DeviceConnectorState,
  DeviceConnectorStatus,
} from "@bd777/foundry-protocol";
import type { BadgeProps } from "../../components/ui/badge";
import { i18n } from "../../i18n";
import { relativeWhen } from "../../lib/time-format";

/** A device-held connector's state on a device, if the device read it. */
export function stateOf(
  device: DeviceConnectorDevice,
  kind: string,
): DeviceConnectorState | undefined {
  return device.states.find((state) => state.kind === kind);
}

export function deviceStatusTone(
  status: DeviceConnectorStatus,
): NonNullable<BadgeProps["tone"]> {
  switch (status) {
    case "ready":
      return "online";
    case "expiring":
      return "brass";
    case "expired":
    case "error":
      return "warn";
    case "signed_out":
      return "neutral";
    case "not_installed":
    case "unavailable":
      return "slate";
  }
}

export function deviceStatusLabel(status: DeviceConnectorStatus): string {
  return i18n.t(`externalAccounts:deviceStatus.${status}`);
}

/** Who is signed in, where and until when ("someone · cn · expires in 29 days"). */
export function signedInText(state: DeviceConnectorState): string {
  return [
    state.identity
      ? i18n.t("externalAccounts:deviceHeld.signedInAs", {
          name: state.identity,
        })
      : i18n.t("externalAccounts:deviceHeld.signedIn"),
    state.sites?.length
      ? i18n.t("externalAccounts:deviceHeld.sites", {
          sites: state.sites.join(", "),
        })
      : "",
    state.expiresAt
      ? i18n.t(
          state.status === "expired"
            ? "externalAccounts:deviceHeld.expired"
            : "externalAccounts:deviceHeld.expires",
          { when: relativeWhen(state.expiresAt) },
        )
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Which copy of the tool sessions use, and when it was read. */
export function toolText(
  connector: ConnectorDescriptor,
  state: DeviceConnectorState,
): string {
  return [
    state.version
      ? i18n.t(
          state.installSource === "foundry"
            ? "externalAccounts:deviceHeld.versionFoundry"
            : "externalAccounts:deviceHeld.versionDevice",
          { name: connector.label, version: state.version },
        )
      : "",
    i18n.t("externalAccounts:deviceHeld.checked", {
      when: relativeWhen(state.checkedAt),
    }),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Compares dotted versions numerically ("0.171.0" > "0.170.2"). */
export function newerVersion(latest?: string, current?: string): boolean {
  if (!latest || !current) return false;
  const parts = (value: string) =>
    value.split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  const [a, b] = [parts(latest), parts(current)];
  for (let index = 0; index < 3; index += 1)
    if ((a[index] ?? 0) !== (b[index] ?? 0))
      return (a[index] ?? 0) > (b[index] ?? 0);
  return false;
}
