import { ToastFeedback } from "../../components/ui/toast";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  DeviceProfileBinding,
  DeviceProjection,
  ProfileDefinition,
  ProviderHealth,
} from "@bd777/foundry-protocol";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { ConfirmButton } from "../../components/ui/confirm-button";
import { runtimeMeta } from "../../components/ui/runtime-mark";
import {
  RuntimeActionButton,
  RuntimeStateNote,
} from "../../components/devices/runtime-readiness";
import { connectionSelection, loopbackHost } from "../../lib/model-connections";
import {
  deviceReadiness,
  runtimesToInstall,
  type DeviceReadiness,
} from "../../lib/device-readiness";
import { installRuntime, useRuntimeInstalls } from "../../lib/runtime-installs";

export function ConnectionDevices({
  devices,
  bindings,
  profiles = [],
  providerHealth = [],
  profile,
  onSave,
}: {
  devices: DeviceProjection[];
  bindings: DeviceProfileBinding[];
  /** Every server profile, to count what each device's runtime serves. */
  profiles?: ProfileDefinition[];
  providerHealth?: ProviderHealth[];
  profile: ProfileDefinition;
  onSave: (deviceId: string, profileIds: string[]) => Promise<unknown>;
}) {
  const { t } = useTranslation("profiles");
  const { t: tDevices } = useTranslation("devices");
  const installs = useRuntimeInstalls();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Promoted from a provider at its device's own loopback address: no other
  // device reaches it, so it is offered only there (the server refuses too).
  const boundTo = profile.promotedFrom?.deviceBound
    ? profile.promotedFrom.deviceId
    : undefined;
  const name = runtimeMeta(profile.runtime).productName;

  async function save(
    device: DeviceProjection,
    enabled: boolean,
    readiness: DeviceReadiness,
  ): Promise<void> {
    setBusy(true);
    setError("");
    try {
      await onSave(
        device.id,
        connectionSelection(bindings, device.id, profile.id, enabled),
      );
      // Assigning is the intent to run it there: install its runtime now.
      if (enabled)
        for (const runtime of runtimesToInstall(readiness, [profile.runtime]))
          void installRuntime(device.id, runtime);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t("connectionDevices.updateFailed"),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="fdy-connection-devices">
      <strong>{t("connectionDevices.title")}</strong>
      <p>{t("connectionDevices.intro")}</p>
      {boundTo ? (
        <p>
          {t("connectionDevices.deviceBound", {
            device:
              devices.find((device) => device.id === boundTo)?.label ?? boundTo,
            address: loopbackHost(profile.baseUrl) ?? profile.baseUrl,
          })}
        </p>
      ) : null}
      {!devices.length ? <p>{t("connectionDevices.noDevices")}</p> : null}
      {devices.map((device) => {
        const assigned = bindings.some(
          (row) =>
            row.deviceId === device.id &&
            row.profileId === profile.id &&
            row.enabled,
        );
        const unreachable = Boolean(boundTo) && device.id !== boundTo;
        const readiness = deviceReadiness({
          device,
          providerHealth,
          bindings,
          profiles,
          installs,
        });
        const installsOnAssign =
          runtimesToInstall(readiness, [profile.runtime]).length > 0;
        return (
          <div className="fdy-management-row" key={device.id}>
            <span>
              <strong>{device.label}</strong>
              <small>
                {device.status === "connected"
                  ? t("connectionDevices.online")
                  : t("connectionDevices.offline")}
              </small>
              <RuntimeStateNote
                assigned={assigned}
                device={device}
                readiness={readiness}
                runtime={profile.runtime}
              />
            </span>
            <Badge tone="neutral">
              {assigned
                ? t("connectionDevices.assigned")
                : t("connectionDevices.notAssigned")}
            </Badge>
            {assigned ? (
              <RuntimeActionButton
                device={device}
                readiness={readiness}
                row={readiness.runtimes[profile.runtime]}
              />
            ) : null}
            {/* Granting access is a single click; removing it — a destructive
                change on another device — needs an explicit second click. */}
            {assigned ? (
              <ConfirmButton
                confirmLabel={t("connectionDevices.removeConfirm", {
                  connection: profile.label,
                  device: device.label,
                })}
                disabled={busy}
                onConfirm={() => void save(device, false, readiness)}
                size="sm"
                variant="secondary"
                aria-label={t("connectionDevices.removeLabel", {
                  connection: profile.label,
                  device: device.label,
                })}
              >
                {t("connectionDevices.removeAccess")}
              </ConfirmButton>
            ) : unreachable ? null : (
              <Button
                disabled={busy}
                size="sm"
                variant="secondary"
                aria-label={
                  installsOnAssign
                    ? tDevices("readiness.assign.andInstallLabel", {
                        connection: profile.label,
                        device: device.label,
                        name,
                      })
                    : t("connectionDevices.assignLabel", {
                        connection: profile.label,
                        device: device.label,
                      })
                }
                onClick={() => void save(device, true, readiness)}
              >
                {installsOnAssign
                  ? tDevices("readiness.assign.andInstall", { name })
                  : t("connectionDevices.assign")}
              </Button>
            )}
          </div>
        );
      })}
      {error ? <ToastFeedback tone="error" title={error} /> : null}
    </section>
  );
}
