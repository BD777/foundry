import type {
  ConnectorPackageView,
  ConnectorServerHeldDeviceCheck,
  ConnectorServerHeldInstance,
} from "@bd777/foundry-protocol";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { setConnectorPackageDevices } from "../../api";
import { Button } from "../../components/ui/button";
import type { ToastTone } from "../../components/ui/toast";
import { errorText } from "./account-format";

/**
 * Whether the package is enabled on the devices that can use an instance,
 * with a one-click enable for a device-network instance's other devices.
 */
export function DeviceAvailability({
  devices,
  probeDeviceId,
}: {
  devices: ConnectorServerHeldDeviceCheck[] | undefined;
  probeDeviceId: string | undefined;
}) {
  const { t } = useTranslation("externalAccounts");
  const checks = devices ?? [];
  const usable = checks.filter((check) => check.status === "ok");
  const unavailable = checks.filter((check) => check.status !== "ok");
  const probeName =
    checks.find((check) => check.deviceId === probeDeviceId)?.name ??
    probeDeviceId ??
    "";
  const reason = (check: ConnectorServerHeldDeviceCheck) => {
    if (check.status === "not_applicable")
      return t("serverHeld.deviceLocalOnly", { device: probeName });
    const detail = check.detail
      ? t("serverHeld.deviceDetail", { detail: check.detail })
      : "";
    return `${t(
      check.status === "unreachable"
        ? "serverHeld.deviceUnreachable"
        : "serverHeld.deviceCheckFailed",
    )}${detail}`;
  };
  return (
    <>
      <span className="wrap-anywhere">
        {usable.length
          ? t("serverHeld.availableOn", {
              devices: usable.map((check) => check.name).join(", "),
            })
          : t("serverHeld.noAvailableDevice")}
      </span>
      {unavailable.map((check) => (
        <span className="wrap-anywhere" key={check.deviceId}>
          {t("serverHeld.deviceNotAvailable", {
            device: check.name,
            reason: reason(check),
          })}
        </span>
      ))}
    </>
  );
}

export function InstancePackageState({
  instance,
  view,
  onChanged,
  onNotice,
}: {
  instance: ConnectorServerHeldInstance;
  view: ConnectorPackageView;
  onChanged?: (view: ConnectorPackageView) => void;
  onNotice: (message: string, tone?: ToastTone) => void;
}) {
  const { t } = useTranslation("externalAccounts");
  const [enabling, setEnabling] = useState<string>();
  const usable = view.instances?.find((entry) => entry.id === instance.id);
  if (!usable || usable.deviceIds.length === 0) return null;
  const devices = view.devices.filter((device) =>
    usable.deviceIds.includes(device.deviceId),
  );
  const enabled = devices.filter((device) => device.selected);
  const missing = devices.filter((device) => !device.selected);
  const command = view.connector.tool.command;

  async function enable(deviceId: string) {
    setEnabling(deviceId);
    try {
      const selected = view.devices
        .filter((device) => device.selected)
        .map((device) => device.deviceId);
      const updated = await setConnectorPackageDevices(view.connector.kind, [
        ...selected,
        deviceId,
      ]);
      onChanged?.(updated);
      onNotice(t("connectorPackage.saved"));
    } catch (cause) {
      onNotice(errorText(cause), "error");
    } finally {
      setEnabling(undefined);
    }
  }

  return (
    <>
      {enabled.length ? (
        <span className="wrap-anywhere">
          {t("serverHeld.packageEnabledOn", {
            devices: enabled.map((device) => device.name).join(", "),
          })}
        </span>
      ) : null}
      {missing.length ? (
        <span className="wrap-anywhere">
          {t("serverHeld.packageNotEnabledOn", {
            devices: missing.map((device) => device.name).join(", "),
            command,
          })}
        </span>
      ) : null}
      {missing.map((device) => (
        <Button
          busy={enabling === device.deviceId}
          className="w-fit"
          disabled={!device.eligible || enabling !== undefined}
          key={device.deviceId}
          onClick={() => void enable(device.deviceId)}
          size="sm"
          variant="secondary"
        >
          {enabling === device.deviceId
            ? t("serverHeld.enablingPackage")
            : t("serverHeld.enablePackage", { device: device.name })}
        </Button>
      ))}
    </>
  );
}
