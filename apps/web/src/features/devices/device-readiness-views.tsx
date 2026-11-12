import type { DeviceProjection } from "@bd777/foundry-protocol";
import { useTranslation } from "react-i18next";
import { Alert } from "../../components/ui/alert";
import {
  DeviceHealthNotices,
  DeviceOfflineNotice,
} from "../../components/devices/device-recovery";
import { DeviceReadinessPanel } from "../../components/devices/runtime-readiness";
import type { DeviceReadiness } from "../../lib/device-readiness";
import { deviceConnection } from "../../lib/device-connection";

/** Offline: since when, why, how to bring it back. Online: hidden rules. */
export function DeviceStatusNotices({
  device,
  readiness,
}: {
  device: DeviceProjection;
  readiness: DeviceReadiness;
}) {
  const { t } = useTranslation("devices");
  const connection = deviceConnection(device);
  if (connection === "reconnecting") {
    return (
      <Alert tone="info" title={t("status.reconnecting")}>
        {t("detail.reconnecting")}
      </Alert>
    );
  }
  return connection === "offline" ? (
    <DeviceOfflineNotice device={device} readiness={readiness} />
  ) : (
    <DeviceHealthNotices device={device} readiness={readiness} />
  );
}

/** A newly paired device's readiness, once its first report arrives. */
export function PairedReadiness({
  device,
  readiness,
}: {
  device?: DeviceProjection;
  readiness?: DeviceReadiness;
}) {
  const { t } = useTranslation("devices");
  return device && readiness ? (
    <DeviceReadinessPanel
      device={device}
      description={t("readiness.pairedIntro")}
      readiness={readiness}
    />
  ) : null;
}
