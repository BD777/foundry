import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { DeviceProjection } from "@bd777/foundry-protocol";
import { Alert } from "../../components/ui/alert";
import { isRemovedDevice } from "../../lib/devices";

/** Source state and connectivity are separate from permanent removal. */
export function KnowledgeDeviceStatus({
  device,
  children,
}: {
  device: DeviceProjection | undefined;
  children: ReactNode;
}) {
  const { t } = useTranslation("personalAgent");
  if (isRemovedDevice(device))
    return (
      <Alert tone="warning" title={t("settings.devices.removed")}>
        {t("settings.devices.removedSourceHint")}
      </Alert>
    );
  return (
    <>
      {children}
      {device?.status !== "connected" ? (
        <p role="status" className="fdy-pa-field-hint">
          {t("knowledge.offlineSource")}
        </p>
      ) : null}
    </>
  );
}

/** A stable lifecycle dependency: unrelated device heartbeats do not reload sources. */
export function useRemovedKnowledgeDevices(
  devices: DeviceProjection[],
): Set<string> {
  const key = devices
    .filter(isRemovedDevice)
    .map((d) => d.id)
    .sort()
    .join("\n");
  return useMemo(() => new Set(key ? key.split("\n") : []), [key]);
}

/** Labels shared by current source state, immutable receipts and pending work. */
export function useKnowledgeStateLabels() {
  const { t } = useTranslation("personalAgent");
  function sourceState(value: string) {
    const known = [
      "pending",
      "waiting",
      "active",
      "migrating",
      "frozen",
      "activating",
      "freezing",
      "copying",
      "verifying",
      "retiring",
      "complete",
      "cancelled",
      "aborting",
      "writing",
      "applied",
      "superseded",
      "forgotten",
      "forgetting",
      "missing",
      "revoked",
    ];
    return known.includes(value)
      ? t(`knowledge.states.${value}` as never)
      : value;
  }
  function sourceReason(value: string) {
    if (value === "device_removed") return t("settings.devices.removed");
    const known = [
      "memory_device_offline",
      "memory_worker_update_required",
      "knowledge_owner_required",
      "memory_workspace_must_be_private",
      "memory_device_must_be_owned",
      "not_empty",
      "fenced",
      "unsafe_path",
      "locked",
      "revision_conflict",
      "external_edit",
      "forgotten",
      "idempotency_conflict",
      "knowledge_location_unavailable",
      "knowledge_authority_not_ready",
      "authority_initialization_changed",
    ];
    return known.includes(value)
      ? t(`knowledge.reasons.${value}` as never)
      : value;
  }
  return { sourceState, sourceReason };
}
