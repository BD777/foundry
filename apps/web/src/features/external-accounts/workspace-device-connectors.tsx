import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  DeviceConnectorBindingInput,
  DeviceConnectorDevice,
  WorkspaceDeviceConnectors,
} from "@bd777/foundry-protocol";
import {
  getWorkspaceDeviceConnectors,
  setWorkspaceDeviceConnectors,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/field";
import { Panel } from "../../components/ui/panel";
import type { ConnectorType } from "../../lib/connector-types";
import { navigateToConnectors } from "../../lib/in-app-navigation";
import { errorText } from "./account-format";
import {
  deviceStatusLabel,
  deviceStatusTone,
  signedInText,
  stateOf,
} from "./device-held-format";

/**
 * A workspace's sections for device-held connectors: which of the caller's
 * devices lend their sign-in to sessions here (and whether other members'
 * sessions on that device may use it too), and the devices other members
 * bound, without their sign-in.
 */
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
  const { t } = useTranslation("externalAccounts");
  const [view, setView] = useState<WorkspaceDeviceConnectors>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setView(undefined);
    setError("");
    getWorkspaceDeviceConnectors(workspaceId)
      .then((next) => !cancelled && setView(next))
      .catch((cause) => !cancelled && setError(errorText(cause)));
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const own = (view?.bindings ?? []).filter(
    (binding) => binding.grantedBy === currentUserId,
  );

  async function save(
    kind: string,
    device: DeviceConnectorDevice,
    change: { use: boolean; members?: boolean },
    notice: string,
  ) {
    const others = own.filter(
      (binding) =>
        !(binding.kind === kind && binding.deviceId === device.deviceId),
    );
    const bindings: DeviceConnectorBindingInput[] = others.map((binding) => ({
      kind: binding.kind,
      deviceId: binding.deviceId,
      members: binding.members,
    }));
    if (change.use)
      bindings.push({
        kind,
        deviceId: device.deviceId,
        members: change.members ?? false,
      });
    setBusy(true);
    try {
      setView(await setWorkspaceDeviceConnectors(workspaceId, bindings));
      onNotice(notice);
    } catch (cause) {
      onNotice(t("workspace.saveFailed", { error: errorText(cause) }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {kinds.map((kind) => {
        const connector = view?.connectors.find((entry) => entry.kind === kind);
        const label = connector?.label ?? kind;
        const devices = (view?.devices ?? []).filter((device) => {
          const state = stateOf(device, kind);
          return state?.installed && state.status !== "unavailable";
        });
        const theirs = (view?.bindings ?? []).filter(
          (binding) =>
            binding.kind === kind && binding.grantedBy !== currentUserId,
        );
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
                <p>{t(`workspace.binding.${kind}`)}</p>
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
            {error ? (
              <Alert
                title={t("workspace.devicesLoadFailed", { error })}
                tone="error"
              />
            ) : !view ? (
              <p className="fdy-xacc-muted" role="status">
                {t("workspace.loading")}
              </p>
            ) : devices.length === 0 ? (
              <p className="fdy-xacc-muted">
                {t("workspace.noDevices", { name: label })}
              </p>
            ) : (
              <ul className="fdy-xacc-list">
                {devices.map((device) => {
                  const state = stateOf(device, kind)!;
                  const binding = own.find(
                    (entry) =>
                      entry.kind === kind && entry.deviceId === device.deviceId,
                  );
                  const locked = busy || Boolean(readOnlyReason);
                  return (
                    <li className="fdy-xacc-binding-row" key={device.deviceId}>
                      <span className="fdy-xacc-binding-options">
                        <label className="fdy-xacc-check">
                          <Checkbox
                            checked={Boolean(binding)}
                            disabled={locked}
                            onChange={(event) =>
                              void save(
                                kind,
                                device,
                                { use: event.currentTarget.checked },
                                t(
                                  event.currentTarget.checked
                                    ? "workspace.deviceBound"
                                    : "workspace.deviceUnbound",
                                  { name: label, device: device.name },
                                ),
                              )
                            }
                          />
                          <span>
                            {t("workspace.useDevice", {
                              name: label,
                              device: device.name,
                            })}
                            <small>
                              {state.signedIn
                                ? signedInText(state)
                                : deviceStatusLabel(state.status)}
                            </small>
                          </span>
                        </label>
                        {binding ? (
                          <label className="fdy-xacc-check">
                            <Checkbox
                              checked={binding.members}
                              disabled={locked}
                              onChange={(event) =>
                                void save(
                                  kind,
                                  device,
                                  {
                                    use: true,
                                    members: event.currentTarget.checked,
                                  },
                                  t(
                                    event.currentTarget.checked
                                      ? "workspace.membersOn"
                                      : "workspace.membersOff",
                                    { name: label, device: device.name },
                                  ),
                                )
                              }
                            />
                            <span>
                              {t("workspace.members", { device: device.name })}
                              <small>{t("workspace.membersHint")}</small>
                            </span>
                          </label>
                        ) : null}
                      </span>
                      <Badge tone={deviceStatusTone(state.status)}>
                        {deviceStatusLabel(state.status)}
                      </Badge>
                    </li>
                  );
                })}
              </ul>
            )}
            {theirs.length > 0 ? (
              <>
                <p className="fdy-xacc-muted">{t("workspace.others")}</p>
                <ul className="fdy-xacc-list">
                  {theirs.map((binding) => (
                    <li
                      className="fdy-xacc-binding-row"
                      key={`${binding.kind}:${binding.deviceId}`}
                    >
                      <span className="fdy-xacc-identity">
                        <strong>
                          {binding.deviceName || binding.deviceId}
                        </strong>
                        <small>
                          {t(
                            binding.members
                              ? "workspace.othersMembers"
                              : "workspace.othersOwner",
                          )}
                        </small>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </Panel>
        );
      })}
    </>
  );
}
