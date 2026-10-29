import type { ToastTone } from "../../components/ui/toast";
import { DeviceAuthorizationGroups } from "./device-authorization-groups";
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
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { FieldHint, Checkbox } from "../../components/ui/field";
import { Panel } from "../../components/ui/panel";
import { SelectMenu } from "../../components/ui/select-menu";
import type { ConnectorType } from "../../lib/connector-types";
import { navigateToConnectors } from "../../lib/in-app-navigation";
import { errorText, relativeWhen } from "./account-format";
import {
  deviceStatusLabel,
  deviceStatusTone,
  signedInText,
  stateOf,
} from "./device-held-format";
import {
  DeviceSignInDialog,
  type DeviceSignInTarget,
} from "./device-sign-in-dialog";
import { Skeleton } from "../../components/ui/loading";
import { ConnectorSetupSteps } from "./connector-setup-steps";
import { CredentialHolding } from "./credential-holding";

/** Only execution targets registered to this workspace, never a credential pool. */
export function WorkspaceDeviceConnectors({
  kinds,
  workspaceId,
  currentUserId,
  readOnlyReason,
  onNotice,
}: {
  kinds: ConnectorType[];
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
      {kinds.map((kind) => {
        const descriptor = view?.connectors.find((c) => c.kind === kind);
        const label = descriptor?.label ?? kind;
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
        const reachable = device?.online && device.supported;
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
          });
        };
        return (
          <Panel
            aria-label={label}
            className="fdy-xacc-section"
            key={kind}
            role="region"
          >
            <div className="fdy-xacc-section-head fdy-xacc-section-head-row">
              <span className="fdy-xacc-section-head">
                <strong>{label}</strong>
                <CredentialHolding type={kind} />
                <p>
                  {t("workspace.deviceScope", { device: target?.name ?? "…" })}
                </p>
              </span>
              <Button
                onClick={() => navigateToConnectors(kind)}
                size="sm"
                variant="ghost"
              >
                {t("workspace.manage")}
                <ChevronRight size={14} />
              </Button>
            </div>
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
                <li className="fdy-xacc-row">
                  <div className="fdy-xacc-row-main">
                    <span className="fdy-xacc-identity">
                      <strong>{device.name}</strong>
                      {duplicateDeviceName ? (
                        <small>{device.deviceId}</small>
                      ) : null}
                      {usable && device.supported ? (
                        <span>
                          {t("workspace.ownerAvailable", {
                            device: device.name,
                          })}
                        </span>
                      ) : null}
                      <span>
                        {state?.signedIn
                          ? signedInText(state)
                          : state
                            ? deviceStatusLabel(state.status)
                            : t("deviceHeld.notRead")}
                      </span>
                      <small>
                        {!device.online
                          ? t(
                              state
                                ? "deviceHeld.offline"
                                : "deviceHeld.offlineUnknown",
                              {
                                when: state
                                  ? relativeWhen(state.checkedAt)
                                  : "",
                              },
                            )
                          : !device.supported
                            ? t("deviceHeld.workerTooOld", { name: label })
                            : state?.statusDetail ||
                              (state
                                ? t("workspace.lastRead", {
                                    when: relativeWhen(state.checkedAt),
                                  })
                                : "")}
                      </small>
                    </span>
                    {state ? (
                      <Badge tone={deviceStatusTone(state.status)}>
                        {deviceStatusLabel(state.status)}
                      </Badge>
                    ) : null}
                  </div>
                  <div className="fdy-xacc-row-actions">
                    <span className="fdy-xacc-row-buttons">
                      {reachable &&
                      descriptor?.authentication !== "local" &&
                      (state?.status === "signed_out" ||
                        state?.status === "expired") ? (
                        <Button
                          disabled={locked}
                          onClick={authorize}
                          size="sm"
                          variant="primary"
                        >
                          {t("workspace.signInDevice")}
                        </Button>
                      ) : null}
                      {reachable ? (
                        <Button
                          disabled={locked}
                          onClick={() => void check(device, kind)}
                          size="sm"
                          variant="ghost"
                        >
                          {t("deviceHeld.checkAgain")}
                        </Button>
                      ) : null}
                    </span>
                  </div>
                  {descriptor ? (
                    <ConnectorSetupSteps
                      connector={descriptor}
                      device={device}
                      onState={(next) => showState(device.deviceId, next)}
                      state={state}
                    />
                  ) : null}
                  {usable || binding ? (
                    <label className="fdy-xacc-check">
                      <Checkbox
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
                </li>
              </ul>
            )}
            {descriptor?.authentication === "local" ? (
              <p className="fdy-xacc-muted">
                {t("workspace.localAuthentication", { name: label })}
              </p>
            ) : null}
            {descriptor && device ? (
              <DeviceAuthorizationGroups
                connector={descriptor}
                device={device}
                state={state}
                disabled={locked}
                onState={(next) => showState(device.deviceId, next)}
              />
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
          </Panel>
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
