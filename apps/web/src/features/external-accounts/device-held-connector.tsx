import type { ToastTone } from "../../components/ui/toast";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  DeviceConnectorDevice,
  DeviceConnectorState,
  DeviceConnectorsView,
} from "@bd777/foundry-protocol";
import {
  checkDeviceConnector,
  getDeviceConnectors,
  signOutDeviceConnector,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { Panel } from "../../components/ui/panel";
import { errorText, relativeWhen } from "./account-format";
import { DeviceConnectorRow } from "./device-connector-row";
import { stateOf } from "./device-held-format";
import {
  DeviceSignInDialog,
  type DeviceSignInTarget,
} from "./device-sign-in-dialog";
import { Skeleton, Spinner } from "../../components/ui/loading";

const offlineRecheckMs = 20_000;

export interface DeviceHeldConnectorProps {
  /** The connector's kind in the catalog ("bytedcli"). */
  kind: string;
  onNotice: (message: string, tone?: ToastTone) => void;
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

  // An offline device's actions wait for it: read the list again now and
  // then, so they turn on once it is back.
  const someOffline = view?.devices.some((device) => !device.online) ?? false;
  useEffect(() => {
    if (!someOffline) return;
    const timer = setInterval(() => void load(false), offlineRecheckMs);
    return () => clearInterval(timer);
  }, [someOffline]);

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
      onNotice(t("notices.failed", { error: errorText(cause) }), "error");
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
    return <Skeleton label={t("deviceHeld.loading")} rows={2} variant="rows" />;
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
          aria-busy={checking}
          disabled={checking}
          onClick={() => void checkAll()}
          size="sm"
          variant="ghost"
        >
          {checking ? <Spinner /> : <RefreshCw size={14} />}
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
              disabled={
                !device.online ||
                !device.supported ||
                connector.authentication === "local"
              }
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
              <DeviceConnectorRow
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
