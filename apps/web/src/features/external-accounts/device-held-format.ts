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

/** Whether Foundry can install the connector's tool on a device. */
export function installable(
  connector: ConnectorDescriptor,
  device: DeviceConnectorDevice,
): boolean {
  if (connector.tool.source === "npm") return true;
  return connector.tool.source === "installer" && !!device.installerSupported;
}

/** The copy on the device is older than the connector needs. */
export function outdated(
  connector: ConnectorDescriptor,
  state: DeviceConnectorState | undefined,
): boolean {
  return (
    !!state?.installed &&
    !!state.version &&
    newerVersion(connector.tool.minimumVersion, state.version)
  );
}

/**
 * What the row offers to install, if anything: the tool is missing, or the
 * device's copy is older than the connector's minimum.
 */
export function installNeed(
  connector: ConnectorDescriptor,
  state: DeviceConnectorState | undefined,
): "missing" | "outdated" | undefined {
  if (!state || connector.tool.source === "device") return undefined;
  if (state.status === "not_installed") return "missing";
  return outdated(connector, state) ? "outdated" : undefined;
}

/**
 * The terminal commands that sign a local-authentication connector in on
 * the device, first the one to copy. A copy Foundry installed lives in
 * ~/.local/bin, which a terminal may not have on PATH yet.
 */
export function localSignInCommands(
  connector: ConnectorDescriptor,
  state: DeviceConnectorState | undefined,
): { primary: string; keys: string; renew: string } | undefined {
  if (connector.adapter !== "aws") return undefined;
  const aws = state?.installSource === "foundry" ? "~/.local/bin/aws" : "aws";
  return {
    primary: `${aws} configure sso --profile default`,
    keys: `${aws} configure`,
    renew: `${aws} sso login`,
  };
}

/** The newer of two readings of one connector on one device. */
export function newestState(
  a: DeviceConnectorState | undefined,
  b: DeviceConnectorState | undefined,
): DeviceConnectorState | undefined {
  if (!a || !b) return a ?? b;
  return Date.parse(b.checkedAt) > Date.parse(a.checkedAt) ? b : a;
}
