import type {
  ConnectorDescriptor,
  DeviceConnectorDevice,
  DeviceConnectorState,
} from "@bd777/foundry-protocol";
import { useTranslation } from "react-i18next";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { RowMenu, type RowMenuItem } from "../../components/ui/row-menu";
import { relativeWhen } from "./account-format";
import {
  connectorInstallKey,
  installConnector,
  useConnectorInstalls,
} from "./connector-installs";
import { ConnectorSetupSteps } from "./connector-setup-steps";
import { DeviceAuthorizationGroups } from "./device-authorization-groups";
import {
  deviceStatusLabel,
  deviceStatusTone,
  installNeed,
  newerVersion,
  newestState,
  signedInText,
  toolText,
} from "./device-held-format";

/**
 * One device on a device-held connector's tab: who is signed in there (or
 * why no one is), the tool's copy and version, its status and the one
 * action that moves it forward. Installing and the terminal sign-in are
 * steps inside the row. The menu appears only when it holds more than
 * checking again, which the tab's header already offers.
 */
export function DeviceConnectorRow({
  connector,
  distinguishDevice,
  device,
  state: shown,
  busy,
  onState,
  onCheck,
  onSignIn,
  onSignOut,
}: {
  connector: ConnectorDescriptor;
  distinguishDevice: boolean;
  device: DeviceConnectorDevice;
  state?: DeviceConnectorState;
  busy: boolean;
  onState: (state: DeviceConnectorState) => void;
  onCheck: () => void;
  onSignIn: () => void;
  onSignOut: () => void;
}) {
  const { t } = useTranslation("externalAccounts");
  const activity = useConnectorInstalls().get(
    connectorInstallKey(device.deviceId, connector.kind),
  );
  // An install that finished while this tab was closed has the newer reading.
  const state = newestState(shown, activity?.result);
  const installing = activity?.state === "running";
  const locked = busy || installing;
  const reachable = device.online && device.supported;
  const status = state?.status;
  const settingUp = Boolean(installNeed(connector, state)) || installing;
  // The server is reading it now; what shows is the last reading meanwhile.
  const checking = device.checking?.includes(connector.kind) ?? false;
  const summary = !state
    ? t(checking ? "deviceHeld.checkingNow" : "deviceHeld.notRead")
    : state.signedIn
      ? signedInText(state)
      : status === "not_installed"
        ? settingUp
          ? ""
          : t("deviceHeld.notInstalled", { name: connector.label })
        : status === "error"
          ? t("deviceHeld.readFailed", { detail: state.statusDetail ?? "" })
          : t("deviceHeld.notSignedIn");
  const where = !device.online
    ? t(state ? "deviceHeld.offline" : "deviceHeld.offlineUnknown", {
        when: state ? relativeWhen(state.checkedAt) : "",
      })
    : !device.supported
      ? t("deviceHeld.workerTooOld", { name: connector.label })
      : state && checking
        ? t("deviceHeld.checkingSince", { when: relativeWhen(state.checkedAt) })
        : state && state.installed
          ? toolText(connector, state)
          : state
            ? t("deviceHeld.checked", { when: relativeWhen(state.checkedAt) })
            : "";
  const install = () =>
    void installConnector(device.deviceId, connector.kind).then((next) => {
      if (next) onState(next);
    });
  const upgrade =
    state?.installSource === "foundry" &&
    (connector.tool.source === "installer" ||
      newerVersion(state.latestVersion, state.version));
  const extra: RowMenuItem[] = [
    ...(reachable && upgrade && connector.tool.source !== "device"
      ? [
          {
            key: "upgrade",
            label:
              connector.tool.source === "npm"
                ? t("deviceHeld.upgrade", { version: state?.latestVersion })
                : t("deviceHeld.update", { name: connector.label }),
            onSelect: install,
          },
        ]
      : []),
    ...(reachable && connector.authentication !== "local" && state?.signedIn
      ? [
          {
            key: "sign-out",
            label: t("deviceHeld.signOut"),
            onSelect: onSignOut,
            confirm: {
              title: t("deviceHeld.signOutTitle", {
                name: connector.label,
                device: device.name,
              }),
              body: t("deviceHeld.signOutBody", { name: connector.label }),
              action: t("deviceHeld.signOut"),
            },
          },
        ]
      : []),
  ];
  const items: RowMenuItem[] =
    extra.length > 0 && reachable
      ? [
          {
            key: "check",
            label: t("deviceHeld.checkAgain"),
            onSelect: onCheck,
          },
          ...extra,
        ]
      : extra;
  const primary =
    !reachable || !state || connector.authentication === "local" || settingUp
      ? undefined
      : status === "signed_out" || status === "expired"
        ? { label: t("deviceHeld.signIn"), run: onSignIn }
        : status === "expiring"
          ? { label: t("deviceHeld.signInAgain"), run: onSignIn }
          : undefined;
  return (
    <li
      className="fdy-xacc-row fdy-xacc-device-row"
      data-status={status ?? "unknown"}
    >
      <div className="fdy-xacc-row-main">
        <div className="fdy-xacc-identity">
          <strong>{device.name}</strong>
          {distinguishDevice ? <small>{device.deviceId}</small> : null}
          {summary ? <span>{summary}</span> : null}
          {where ? (
            <small aria-busy={checking || undefined}>{where}</small>
          ) : null}
        </div>
        <span className="fdy-xacc-row-side">
          {status ? (
            <Badge tone={deviceStatusTone(status)}>
              {deviceStatusLabel(status)}
            </Badge>
          ) : null}
          {primary ? (
            <Button
              disabled={locked}
              onClick={primary.run}
              size="sm"
              variant="primary"
            >
              {primary.label}
            </Button>
          ) : reachable && !state ? (
            <Button disabled={locked} onClick={onCheck} size="sm">
              {t("deviceHeld.checkAgain")}
            </Button>
          ) : null}
          {items.length > 0 ? (
            <RowMenu
              disabled={locked}
              items={items}
              label={t("actions.more", { name: device.name })}
            />
          ) : null}
        </span>
      </div>
      <ConnectorSetupSteps
        connector={connector}
        device={device}
        onState={onState}
        state={state}
      />
      <DeviceAuthorizationGroups
        connector={connector}
        device={device}
        state={state}
        disabled={locked}
        onState={onState}
      />
    </li>
  );
}
