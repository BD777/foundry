import type {
  ConnectorDescriptor,
  ConnectorProgressPayload,
  DeviceConnectorDevice,
  DeviceConnectorState,
  DeviceConnectorStatus,
} from "@bd777/foundry-protocol";
import type { BadgeProps } from "../../components/ui/badge";
import { i18n } from "../../i18n";
import { formatBytes } from "../../lib/format";
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

/**
 * The status in words. "Ready" is "Base login ready" only for a connector
 * with additional authorizations, whose own states show beside it.
 */
export function deviceStatusLabel(
  status: DeviceConnectorStatus,
  connector?: ConnectorDescriptor,
): string {
  if (status === "ready" && connector?.authorizationGroups?.length)
    return i18n.t("externalAccounts:deviceStatus.readyBase");
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

/**
 * What checking the connector in a session's environment found: signed in
 * is one thing, usable in a session another (DeviceConnectorSessionCheck).
 * `problem` is set when the person should look at it.
 */
export function sessionCheckText(
  state: DeviceConnectorState,
): { text: string; problem: boolean }[] {
  const check = state.signedIn ? state.sessionCheck : undefined;
  if (!check) return [];
  const lines = [
    check.usable
      ? {
          text: i18n.t("externalAccounts:deviceHeld.sessionUsable"),
          problem: false,
        }
      : {
          text: i18n.t("externalAccounts:deviceHeld.sessionNotUsable", {
            reason: check.reason ?? "",
          }),
          problem: true,
        },
  ];
  if (check.isolationHolds === false)
    lines.push({
      text: i18n.t("externalAccounts:deviceHeld.isolationLeaks", {
        reason: check.isolationReason ?? "",
      }),
      problem: true,
    });
  return lines;
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

/** The newer of two readings of one connector on one device. */
export function newestState(
  a: DeviceConnectorState | undefined,
  b: DeviceConnectorState | undefined,
): DeviceConnectorState | undefined {
  if (!a || !b) return a ?? b;
  return Date.parse(b.checkedAt) > Date.parse(a.checkedAt) ? b : a;
}

/**
 * A running install's step in words: "Downloading 23.4 MB of 61.0 MB (38%)
 * · 1.2 MB/s", or what it does after the download.
 */
export function installProgressText(
  progress: ConnectorProgressPayload | undefined,
): { text: string; value?: number; max?: number } {
  const ns = "externalAccounts:setupSteps.progress";
  if (!progress) return { text: i18n.t(`${ns}.starting` as const) };
  switch (progress.phase) {
    case "verifying":
      return { text: i18n.t(`${ns}.verifying` as const) };
    case "installing":
      return { text: i18n.t(`${ns}.installing` as const) };
    case "checking":
      return { text: i18n.t(`${ns}.checking` as const) };
  }
  const received = progress.receivedBytes ?? 0;
  const total = progress.totalBytes;
  const speed = progress.bytesPerSecond
    ? i18n.t(`${ns}.speed` as const, {
        speed: formatBytes(progress.bytesPerSecond),
      })
    : "";
  const amount =
    total && total >= received
      ? i18n.t(`${ns}.downloadingOf` as const, {
          received: formatBytes(received),
          total: formatBytes(total),
          percent: Math.floor((received / total) * 100),
        })
      : i18n.t(`${ns}.downloading` as const, {
          received: formatBytes(received),
        });
  return {
    text: [amount, speed].filter(Boolean).join(" · "),
    value: total ? received : undefined,
    max: total || undefined,
  };
}
