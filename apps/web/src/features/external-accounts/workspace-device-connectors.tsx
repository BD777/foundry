import type { ToastTone } from "../../components/ui/toast";
import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  DeviceConnectorDevice,
  DeviceConnectorState,
  WorkspaceDeviceConnectors as WorkspaceView,
} from "@bd777/foundry-protocol";
import {
  checkDeviceConnector,
  getWorkspaceDeviceConnectors,
  setWorkspaceDeviceConnectors,
  signOutDeviceConnector,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { FieldHint, Checkbox } from "../../components/ui/field";
import { SelectMenu } from "../../components/ui/select-menu";
import { navigateToConnectors } from "../../lib/in-app-navigation";
import { errorText } from "./account-format";
import { stateOf } from "./device-held-format";
import {
  DeviceSignInDialog,
  type DeviceSignInTarget,
} from "./device-sign-in-dialog";
import { Skeleton } from "../../components/ui/loading";
import { DeviceConnectorRow } from "./device-connector-row";
import { ConnectorSection } from "./connector-section";
import { CredentialHolding } from "./credential-holding";
import { connectorName, signsInHere } from "./connector-text";

/** Only execution targets registered to this workspace, never a credential pool. */
export function WorkspaceDeviceConnectors({
  workspaceId,
  currentUserId,
  readOnlyReason,
  onNotice,
}: {
  workspaceId: string;
  currentUserId: string;
  readOnlyReason?: string;
  onNotice: (message: string, tone?: ToastTone) => void;
}) {
  const { t } = useTranslation(["externalAccounts", "common"]);
  const [view, setView] = useState<WorkspaceView>();
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const sharingControl = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (busy || !sharingControl.current) return;
    // Disabling the native checkbox during a save blurs it. Restore the
    // initiating control only if the person has not focused something else.
    if (
      sharingControl.current.isConnected &&
      document.activeElement === document.body
    )
      sharingControl.current.focus();
    sharingControl.current = null;
  }, [busy]);
  const [signingIn, setSigningIn] = useState<DeviceSignInTarget>();
  const [bindingFailed, setBindingFailed] = useState<{
    kind: string;
    device: DeviceConnectorDevice;
    members: boolean;
    use: boolean;
  }>();
  useEffect(() => {
    let cancelled = false;
    getWorkspaceDeviceConnectors(workspaceId)
      .then((next) => {
        if (!cancelled) {
          setView(next);
          setSelected(next.defaultDeviceId);
        }
      })
      .catch((cause) => !cancelled && setError(errorText(cause)));
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // A device the server is still reading answers later: read again every
  // few seconds until it has.
  const someChecking =
    view?.devices.some((d) => (d.checking?.length ?? 0) > 0) ?? false;
  useEffect(() => {
    if (!someChecking) return;
    const timer = setInterval(() => {
      getWorkspaceDeviceConnectors(workspaceId)
        .then((next) =>
          setView((current) =>
            current ? { ...current, devices: next.devices } : next,
          ),
        )
        .catch(() => undefined);
    }, 2_000);
    return () => clearInterval(timer);
  }, [someChecking, workspaceId]);

  const own = (view?.bindings ?? []).filter(
    (binding) => binding.grantedBy === currentUserId,
  );
  function showState(deviceId: string, state: DeviceConnectorState) {
    setView(
      (current) =>
        current && {
          ...current,
          devices: current.devices.map((d) =>
            d.deviceId === deviceId
              ? {
                  ...d,
                  states: [
                    ...d.states.filter((s) => s.kind !== state.kind),
                    state,
                  ],
                }
              : d,
          ),
        },
    );
  }
  async function save(
    kind: string,
    device: DeviceConnectorDevice,
    use: boolean,
    members = false,
  ) {
    setBusy(true);
    setError("");
    setBindingFailed(undefined);
    const bindings = own
      .filter((b) => !(b.kind === kind && b.deviceId === device.deviceId))
      .map(({ kind, deviceId, members }) => ({ kind, deviceId, members }));
    if (use) bindings.push({ kind, deviceId: device.deviceId, members });
    try {
      setView(await setWorkspaceDeviceConnectors(workspaceId, bindings));
      onNotice(
        t(members ? "workspace.membersOn" : "workspace.membersOff", {
          name: kind,
          device: device.name,
        }),
      );
    } catch (cause) {
      setError(t("workspace.saveFailed", { error: errorText(cause) }));
      setBindingFailed({ kind, device, members, use });
    } finally {
      setBusy(false);
    }
  }
  async function signOut(
    device: DeviceConnectorDevice,
    kind: string,
    name: string,
  ) {
    setBusy(true);
    setError("");
    try {
      showState(
        device.deviceId,
        await signOutDeviceConnector(device.deviceId, kind),
      );
      onNotice(t("deviceHeld.signedOut", { name, device: device.name }));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  async function check(device: DeviceConnectorDevice, kind: string) {
    setBusy(true);
    setError("");
    try {
      showState(
        device.deviceId,
        await checkDeviceConnector(device.deviceId, kind),
      );
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  const target = view?.executionDevices?.find((d) => d.deviceId === selected);
  const device = view?.devices.find((d) => d.deviceId === selected);
  // The built-in device-held connectors, and those an extension on the
  // selected device provides.
  const connectors = (view?.connectors ?? []).filter(
    (connector) =>
      !connector.extension ||
      (device?.extensionKinds ?? []).includes(connector.kind),
  );
  const duplicateDeviceName =
    (view?.executionDevices.filter((d) => d.name === target?.name).length ??
      0) > 1;
  const locked = busy || Boolean(readOnlyReason) || Boolean(signingIn);
  return (
    <>
      {(view?.executionDevices?.length ?? 0) > 1 ? (
        <>
          <SelectMenu
            ariaLabel={t("workspace.executionDevice")}
            value={selected}
            disabled={locked}
            onChange={(id) => {
              setSelected(id);
              setError("");
              setBindingFailed(undefined);
            }}
            options={view!.executionDevices.map((d) => ({
              value: d.deviceId,
              label: d.name,
              meta: d.deviceId,
            }))}
          />
          <FieldHint>{t("workspace.executionHint")}</FieldHint>
        </>
      ) : null}
      {error ? (
        <Alert title={error} tone="error">
          {bindingFailed ? (
            <Button
              disabled={busy}
              size="sm"
              onClick={() =>
                void save(
                  bindingFailed.kind,
                  bindingFailed.device,
                  bindingFailed.use,
                  bindingFailed.members,
                )
              }
            >
              {t("workspace.retrySharing")}
            </Button>
          ) : null}
        </Alert>
      ) : null}
      {connectors.map((descriptor) => {
        const kind = descriptor.kind;
        const label = connectorName(descriptor);
        const state = device ? stateOf(device, kind) : undefined;
        const binding = own.find(
          (b) => b.kind === kind && b.deviceId === selected,
        );
        const theirs =
          view?.bindings.filter(
            (b) =>
              b.kind === kind &&
              b.deviceId === selected &&
              b.grantedBy !== currentUserId,
          ) ?? [];
        const usable =
          state?.signedIn &&
          (state.status === "ready" || state.status === "expiring");
        const authorize = () => {
          if (!device) return;
          setSigningIn({
            deviceId: device.deviceId,
            deviceName: duplicateDeviceName
              ? `${device.name} (${device.deviceId})`
              : device.name,
            kind,
            label,
            connector: descriptor,
            online: device.online,
          });
        };
        return (
          <ConnectorSection
            actions={
              <Button
                onClick={() => navigateToConnectors(kind)}
                size="sm"
                variant="ghost"
              >
                {t("workspace.manage")}
                <ChevronRight size={14} />
              </Button>
            }
            description={t("workspace.deviceScope", {
              device: target?.name ?? "…",
            })}
            holding={
              <CredentialHolding
                holding={descriptor.holding}
                name={label}
                signOutLocal={descriptor.signIn?.signOut === false}
              />
            }
            key={kind}
            name={label}
          >
            {!view ? (
              <Skeleton
                label={t("workspace.loading")}
                rows={2}
                variant="rows"
              />
            ) : !device ? (
              <p className="fdy-xacc-muted">{t("workspace.deviceOwnerOnly")}</p>
            ) : (
              <ul className="fdy-xacc-list">
                <DeviceConnectorRow
                  busy={locked}
                  connector={descriptor}
                  device={device}
                  distinguishDevice={duplicateDeviceName}
                  note={
                    usable && device.online
                      ? t("workspace.ownerAvailable", { device: device.name })
                      : undefined
                  }
                  onCheck={() => void check(device, kind)}
                  onSignIn={authorize}
                  onSignOut={() => void signOut(device, kind, label)}
                  onState={(next) => showState(device.deviceId, next)}
                  showCheck
                  state={state}
                >
                  {usable || binding ? (
                    <label className="fdy-xacc-check">
                      <Checkbox
                        className="fdy-xacc-check-box"
                        checked={binding?.members ?? false}
                        disabled={locked}
                        onChange={(event) => {
                          sharingControl.current = event.currentTarget;
                          void save(
                            kind,
                            device,
                            event.currentTarget.checked,
                            event.currentTarget.checked,
                          );
                        }}
                      />
                      <span>
                        {t("workspace.members", { device: device.name })}
                        <FieldHint as="small">
                          {t("workspace.membersHint")}
                        </FieldHint>
                      </span>
                    </label>
                  ) : null}
                </DeviceConnectorRow>
              </ul>
            )}
            {!signsInHere(descriptor) ? (
              <p className="fdy-xacc-muted">
                {t("workspace.localAuthentication", { name: label })}
              </p>
            ) : null}
            {theirs.map((b) => (
              <p className="fdy-xacc-muted" key={`${b.kind}:${b.deviceId}`}>
                {t(
                  b.members
                    ? "workspace.othersMembers"
                    : "workspace.othersOwner",
                )}
              </p>
            ))}
            <p className="fdy-xacc-muted">{t("workspace.nativeBoundary")}</p>
          </ConnectorSection>
        );
      })}
      <DeviceSignInDialog
        target={signingIn}
        onClose={() => setSigningIn(undefined)}
        onSignedIn={(state) => {
          const signed = signingIn;
          setSigningIn(undefined);
          const source = view?.devices.find(
            (d) => d.deviceId === signed?.deviceId,
          );
          if (state && source && signed) {
            showState(source.deviceId, state);
            onNotice(
              t("deviceHeld.signedInNotice", {
                name: signed.label,
                device: source.name,
              }),
            );
          }
        }}
      />
    </>
  );
}
