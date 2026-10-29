import type { DeviceProjection } from "@bd777/foundry-protocol";
import { useTranslation } from "react-i18next";
import {
  DeviceHealthNotices,
  DeviceOfflineNotice,
} from "../../components/devices/device-recovery";
import { DeviceReadinessPanel } from "../../components/devices/runtime-readiness";
import type { DeviceReadiness } from "../../lib/device-readiness";

/** Offline: since when, why, how to bring it back. Online: hidden rules. */
export function DeviceStatusNotices({
  device,
  readiness,
}: {
  device: DeviceProjection;
  readiness: DeviceReadiness;
}) {
  return device.status !== "connected" ? (
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
      intro={t("readiness.pairedIntro", { device: device.label })}
      readiness={readiness}
    />
  ) : null;
}
