import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  DeviceProfileBinding,
  DeviceProjection,
  ProfileDefinition,
} from "@bd777/foundry-protocol";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { ConfirmButton } from "../../components/ui/confirm-button";
import { connectionSelection } from "../../lib/model-connections";

export function ConnectionDevices({
  devices,
  bindings,
  profile,
  onSave,
}: {
  devices: DeviceProjection[];
  bindings: DeviceProfileBinding[];
  profile: ProfileDefinition;
  onSave: (deviceId: string, profileIds: string[]) => Promise<unknown>;
}) {
  const { t } = useTranslation("profiles");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <section className="fdy-connection-devices">
      <strong>{t("connectionDevices.title")}</strong>
      <p>{t("connectionDevices.intro")}</p>
      {!devices.length ? <p>{t("connectionDevices.noDevices")}</p> : null}
      {devices.map((device) => {
        const assigned = bindings.some(
          (row) =>
            row.deviceId === device.id &&
            row.profileId === profile.id &&
            row.enabled,
        );
        return (
          <div className="fdy-management-row" key={device.id}>
            <span>
              <strong>{device.label}</strong>
              <small>
                {device.status === "connected"
                  ? t("connectionDevices.online")
                  : t("connectionDevices.offline")}
              </small>
            </span>
            <Badge tone="neutral">
              {assigned
                ? t("connectionDevices.assigned")
                : t("connectionDevices.notAssigned")}
            </Badge>
            {/* Granting access is a single click; removing it — a destructive
                change on another device — needs an explicit second click. */}
            {assigned ? (
              <ConfirmButton
                confirmLabel={t("connectionDevices.removeConfirm", {
                  connection: profile.label,
                  device: device.label,
                })}
                disabled={busy}
                onConfirm={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    await onSave(
                      device.id,
                      connectionSelection(
                        bindings,
                        device.id,
                        profile.id,
                        false,
                      ),
                    );
                  } catch (cause) {
                    setError(
                      cause instanceof Error
                        ? cause.message
                        : t("connectionDevices.updateFailed"),
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
                size="sm"
                variant="secondary"
                aria-label={t("connectionDevices.removeLabel", {
                  connection: profile.label,
                  device: device.label,
                })}
              >
                {t("connectionDevices.removeAccess")}
              </ConfirmButton>
            ) : (
              <Button
                disabled={busy}
                size="sm"
                variant="secondary"
                aria-label={t("connectionDevices.assignLabel", {
                  connection: profile.label,
                  device: device.label,
                })}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    await onSave(
                      device.id,
                      connectionSelection(
                        bindings,
                        device.id,
                        profile.id,
                        true,
                      ),
                    );
                  } catch (cause) {
                    setError(
                      cause instanceof Error
                        ? cause.message
                        : t("connectionDevices.updateFailed"),
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {t("connectionDevices.assign")}
              </Button>
            )}
          </div>
        );
      })}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
