import { DeviceAuthorizationGroups } from "./device-authorization-groups";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ConnectorDescriptor,
  DeviceConnectorDevice,
  DeviceConnectorState,
  DeviceConnectorsView,
} from "@bd777/foundry-protocol";
import {
  checkDeviceConnector,
  getDeviceConnectors,
  installDeviceConnector,
  signOutDeviceConnector,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { Panel } from "../../components/ui/panel";
import { RowMenu, type RowMenuItem } from "../../components/ui/row-menu";
import { errorText, relativeWhen } from "./account-format";
import {
  deviceStatusLabel,
  deviceStatusTone,
  newerVersion,
  signedInText,
  stateOf,
  toolText,
} from "./device-held-format";
import {
  DeviceSignInDialog,
  type DeviceSignInTarget,
} from "./device-sign-in-dialog";

export interface DeviceHeldConnectorProps {
  /** The connector's kind in the catalog ("bytedcli"). */
  kind: string;
  onNotice: (message: string) => void;
}

/**
 * The Connectors page's tab for a device-held connector: the login stays
 * on each device, so the tab lists the person's devices, each with its
 * sign-in, the tool's version and what can be done there. Devices where the
 * connector cannot work (its requirement fails) are named, not offered.
 * Read on open (stale devices are read again) and after each action.
 */
export function DeviceHeldConnector({
  kind,
  onNotice,
}: DeviceHeldConnectorProps) {
  const { t } = useTranslation(["externalAccounts", "common"]);
  const [view, setView] = useState<DeviceConnectorsView>();
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState("");
  const [checking, setChecking] = useState(false);
  const [signingIn, setSigningIn] = useState<DeviceSignInTarget>();

  async function load(refresh: boolean) {
    try {
      setView(await getDeviceConnectors(refresh));
      setLoadError("");
    } catch (cause) {
      setLoadError(errorText(cause));
    }
  }

  useEffect(() => {
    void load(true);
  }, [kind]);

  const connector = view?.connectors.find((entry) => entry.kind === kind);

  function showState(deviceId: string, state: DeviceConnectorState) {
    setView(
      (current) =>
        current && {
          ...current,
          devices: current.devices.map((device) =>
            device.deviceId === deviceId
              ? {
                  ...device,
                  states: [
                    ...device.states.filter((entry) => entry.kind !== kind),
                    state,
                  ],
                }
              : device,
          ),
        },
    );
  }

  async function act(
    device: DeviceConnectorDevice,
    run: () => Promise<DeviceConnectorState>,
    notice: string,
  ) {
    setBusy(device.deviceId);
    try {
      showState(device.deviceId, await run());
      onNotice(notice);
    } catch (cause) {
      onNotice(t("notices.failed", { error: errorText(cause) }));
      void load(false);
    } finally {
      setBusy("");
    }
  }

  async function checkAll() {
    if (!view) return;
    setChecking(true);
    await Promise.allSettled(
      view.devices
        .filter((device) => device.online && device.supported)
        .map((device) =>
          checkDeviceConnector(device.deviceId, kind).then((state) =>
            showState(device.deviceId, state),
          ),
        ),
    );
    setChecking(false);
  }

  if (loadError)
    return (
      <Alert
        title={t("deviceHeld.loadFailed", { error: loadError })}
        tone="error"
      >
        <Button onClick={() => void load(true)} size="sm">
          {t("common:actions.retry")}
        </Button>
      </Alert>
    );
  if (!view)
    return (
      <p className="fdy-xacc-muted" role="status">
        {t("deviceHeld.loading")}
      </p>
    );
  if (!connector)
    return <Alert title={t("deviceHeld.unknown", { kind })} tone="error" />;

  const offered = view.devices.filter(
    (device) => stateOf(device, kind)?.status !== "unavailable",
  );
  const notOffered = view.devices.filter(
    (device) => stateOf(device, kind)?.status === "unavailable",
  );
  const reminders = offered.filter((device) => {
    const status = stateOf(device, kind)?.status;
    return status === "expiring" || status === "expired";
  });
  const requirement = connector.requires
    ?.map((entry) => entry.label)
    .join(", ");
  const signIn = (device: DeviceConnectorDevice) =>
    setSigningIn({
      deviceId: device.deviceId,
      deviceName:
        view.devices.filter((d) => d.name === device.name).length > 1
          ? `${device.name} (${device.deviceId})`
          : device.name,
      kind,
      label: connector.label,
    });

  return (
    <div className="fdy-xacc-tab">
      <div className="fdy-xacc-intro">
        <span>
          <p>
            {t(`deviceHeld.intro.${kind}`, {
              defaultValue: t("deviceHeld.intro.default", {
                name: connector.label,
              }),
            })}
          </p>
        </span>
        <Button
          disabled={checking}
          onClick={() => void checkAll()}
          size="sm"
          variant="ghost"
        >
          <RefreshCw size={14} />
          {checking ? t("deviceHeld.checking") : t("deviceHeld.checkAll")}
        </Button>
      </div>
      {reminders.map((device) => {
        const state = stateOf(device, kind)!;
        return (
          <Alert
            key={device.deviceId}
            title={t(
              state.status === "expired"
                ? "deviceHeld.reminderExpired"
                : "deviceHeld.reminderExpiring",
              {
                name: connector.label,
                device: device.name,
                when: relativeWhen(state.expiresAt),
              },
            )}
            tone="warning"
          >
            <Button
              disabled={!device.online || !device.supported}
              onClick={() => signIn(device)}
              size="sm"
              variant="primary"
            >
              {t("deviceHeld.signInAgain")}
            </Button>
          </Alert>
        );
      })}
      {offered.length === 0 ? (
        <Panel className="fdy-xacc-section">
          <EmptyState
            body={t("deviceHeld.emptyBody", { name: connector.label })}
            title={t("deviceHeld.emptyTitle", { name: connector.label })}
          />
        </Panel>
      ) : (
        <Panel className="fdy-xacc-section">
          <ul className="fdy-xacc-list">
            {offered.map((device) => (
              <DeviceRow
                busy={busy === device.deviceId}
                connector={connector}
                distinguishDevice={
                  view.devices.filter((d) => d.name === device.name).length > 1
                }
                device={device}
                key={device.deviceId}
                onState={(next) => showState(device.deviceId, next)}
                onCheck={() =>
                  void act(
                    device,
                    () => checkDeviceConnector(device.deviceId, kind),
                    t("deviceHeld.checkedNotice", {
                      name: connector.label,
                      device: device.name,
                    }),
                  )
                }
                onInstall={() =>
                  void act(
                    device,
                    () => installDeviceConnector(device.deviceId, kind),
                    t("deviceHeld.installed", {
                      name: connector.label,
                      device: device.name,
                    }),
                  )
                }
                onSignIn={() => signIn(device)}
                onSignOut={() =>
                  void act(
                    device,
                    () => signOutDeviceConnector(device.deviceId, kind),
                    t("deviceHeld.signedOut", {
                      name: connector.label,
                      device: device.name,
                    }),
                  )
                }
                state={stateOf(device, kind)}
              />
            ))}
          </ul>
        </Panel>
      )}
      {notOffered.length > 0 ? (
        <p className="fdy-xacc-muted">
          {t("deviceHeld.notOffered", {
            devices: notOffered.map((device) => device.name).join(", "),
            requirement,
            name: connector.label,
          })}
        </p>
      ) : null}
      <DeviceSignInDialog
        onClose={() => setSigningIn(undefined)}
        onSignedIn={(state) => {
          const target = signingIn;
          setSigningIn(undefined);
          if (target && state) showState(target.deviceId, state);
          else void load(false);
          if (target)
            onNotice(
              t("deviceHeld.signedInNotice", {
                name: target.label,
                device: target.deviceName,
              }),
            );
        }}
        target={signingIn}
      />
    </div>
  );
}

/**
 * One device: its sign-in (or why there is none), the tool's copy and
 * version, and the one action that moves it forward; checking again,
 * upgrading and signing out sit in the menu.
 */
function DeviceRow({
  connector,
  distinguishDevice,
  device,
  state,
  busy,
  onState,
  onCheck,
  onInstall,
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
  onInstall: () => void;
  onSignIn: () => void;
  onSignOut: () => void;
}) {
  const { t } = useTranslation("externalAccounts");
  const reachable = device.online && device.supported;
  const status = state?.status;
  const summary = !state
    ? t("deviceHeld.notRead")
    : state.signedIn
      ? signedInText(state)
      : status === "not_installed"
        ? t("deviceHeld.notInstalled", { name: connector.label })
        : status === "error"
          ? t("deviceHeld.readFailed", { detail: state.statusDetail ?? "" })
          : t("deviceHeld.notSignedIn");
  const where = !device.online
    ? t(state ? "deviceHeld.offline" : "deviceHeld.offlineUnknown", {
        when: state ? relativeWhen(state.checkedAt) : "",
      })
    : !device.supported
      ? t("deviceHeld.workerTooOld", { name: connector.label })
      : state && state.installed
        ? toolText(connector, state)
        : "";
  const upgrade =
    state?.installSource === "foundry" &&
    newerVersion(state.latestVersion, state.version);
  const items: RowMenuItem[] = [
    ...(reachable
      ? [
          {
            key: "check",
            label: t("deviceHeld.checkAgain"),
            onSelect: onCheck,
          },
        ]
      : []),
    ...(reachable && upgrade
      ? [
          {
            key: "upgrade",
            label: t("deviceHeld.upgrade", { version: state?.latestVersion }),
            onSelect: onInstall,
          },
        ]
      : []),
    ...(reachable && state?.signedIn
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
  const primary =
    !reachable || !state
      ? undefined
      : status === "not_installed"
        ? { label: t("deviceHeld.install"), run: onInstall }
        : status === "signed_out" || status === "expired"
          ? { label: t("deviceHeld.signIn"), run: onSignIn }
          : status === "expiring"
            ? { label: t("deviceHeld.signInAgain"), run: onSignIn }
            : undefined;
  return (
    <li className="fdy-xacc-row" data-status={status ?? "unknown"}>
      <div className="fdy-xacc-row-main">
        <div className="fdy-xacc-identity">
          <strong>{device.name}</strong>
          {distinguishDevice ? <small>{device.deviceId}</small> : null}
          <span>{summary}</span>
          {where ? <small>{where}</small> : null}
        </div>
        {status ? (
          <Badge tone={deviceStatusTone(status)}>
            {deviceStatusLabel(status)}
          </Badge>
        ) : null}
      </div>
      {busy && status === "not_installed" ? (
        <p className="fdy-xacc-row-detail" role="status">
          {t("deviceHeld.installing", { name: connector.label })}
        </p>
      ) : null}
      <div className="fdy-xacc-row-actions">
        <span className="fdy-xacc-row-buttons">
          {primary ? (
            <Button
              disabled={busy}
              onClick={primary.run}
              size="sm"
              variant="primary"
            >
              {primary.label}
            </Button>
          ) : reachable && !state ? (
            <Button disabled={busy} onClick={onCheck} size="sm">
              {t("deviceHeld.checkAgain")}
            </Button>
          ) : null}
          <RowMenu
            disabled={busy}
            items={items}
            label={t("actions.more", { name: device.name })}
          />
        </span>
      </div>
      <DeviceAuthorizationGroups
        connector={connector}
        device={device}
        state={state}
        disabled={busy}
        onState={onState}
      />
    </li>
  );
}
