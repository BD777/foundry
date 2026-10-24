import { DeviceAuthorizationGroups } from "./device-authorization-groups";
import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  DeviceConnectorDevice,
  DeviceConnectorState,
  WorkspaceDeviceConnectors as WorkspaceView,
} from "@bd777/foundry-protocol";
import {
  checkDeviceConnector,
  getWorkspaceDeviceConnectors,
  installDeviceConnector,
  setWorkspaceDeviceConnectors,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/field";
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
  onNotice: (message: string) => void;
}) {
  const { t } = useTranslation(["externalAccounts", "common"]);
  const [view, setView] = useState<WorkspaceView>();
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
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
        t(use ? "workspace.deviceBound" : "workspace.deviceUnbound", {
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
  async function check(
    device: DeviceConnectorDevice,
    kind: string,
    install = false,
  ) {
    setBusy(true);
    setError("");
    try {
      showState(
        device.deviceId,
        await (install ? installDeviceConnector : checkDeviceConnector)(
          device.deviceId,
          kind,
        ),
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
          <p className="fdy-xacc-muted">{t("workspace.executionHint")}</p>
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
              {t("workspace.retryBinding")}
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
        const authorize = async () => {
          if (!device) return;
          if (descriptor?.authentication === "local") {
            setBusy(true);
            setError("");
            try {
              const fresh = await checkDeviceConnector(device.deviceId, kind);
              showState(device.deviceId, fresh);
              if (
                fresh.signedIn &&
                (fresh.status === "ready" || fresh.status === "expiring")
              ) {
                await save(kind, device, true);
              } else {
                setError(t("workspace.localAuthentication", { name: label }));
              }
            } catch (cause) {
              setError(errorText(cause));
            } finally {
              setBusy(false);
            }
            return;
          }
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
              <p className="fdy-xacc-muted" role="status">
                {t("workspace.loading")}
              </p>
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
                      {reachable && usable && !binding ? (
                        <Button
                          disabled={locked}
                          onClick={authorize}
                          size="sm"
                          variant="primary"
                        >
                          {t("workspace.useExisting")}
                        </Button>
                      ) : reachable &&
                        descriptor?.authentication !== "local" &&
                        (state?.status === "signed_out" ||
                          state?.status === "expired") ? (
                        <Button
                          disabled={locked}
                          onClick={authorize}
                          size="sm"
                          variant="primary"
                        >
                          {t("workspace.authorize")}
                        </Button>
                      ) : reachable &&
                        state?.status === "not_installed" &&
                        descriptor?.tool.source === "npm" ? (
                        <Button
                          disabled={locked}
                          onClick={() => void check(device, kind, true)}
                          size="sm"
                          variant="primary"
                        >
                          {t("deviceHeld.install")}
                        </Button>
                      ) : null}
                      {binding ? (
                        <>
                          <Badge tone="online">{t("workspace.enabled")}</Badge>
                          <Button
                            disabled={locked}
                            onClick={() => void save(kind, device, false)}
                            size="sm"
                            variant="ghost"
                          >
                            {t("workspace.removeBinding")}
                          </Button>
                        </>
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
                  {binding ? (
                    <label className="fdy-xacc-check">
                      <Checkbox
                        checked={binding.members}
                        disabled={locked}
                        onChange={(event) =>
                          void save(
                            kind,
                            device,
                            true,
                            event.currentTarget.checked,
                          )
                        }
                      />
                      <span>
                        {t("workspace.members", { device: device.name })}
                        <small>{t("workspace.membersHint")}</small>
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
            const old = own.find(
              (b) => b.kind === signed.kind && b.deviceId === source.deviceId,
            );
            void save(signed.kind, source, true, old?.members ?? false);
          }
        }}
      />
    </>
  );
}
