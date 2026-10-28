import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DeviceProjection } from "@bd777/foundry-protocol";
import { setDeviceOutsideFiles } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Checkbox, FieldHint } from "../../components/ui/field";

/**
 * The owner's switch for opening this device's files outside its
 * workspaces from paths answers name. On unless turned off; nobody but the
 * owner ever gets it, and credential stores stay closed either way.
 */
export function DeviceOutsideFiles({
  device,
  onRefresh,
}: {
  device: DeviceProjection;
  onRefresh: () => Promise<void>;
}) {
  const { t } = useTranslation("devices");
  const hintId = useId();
  const [pending, setPending] = useState<boolean>();
  const [saved, setSaved] = useState<boolean>();
  const [failed, setFailed] = useState(false);
  useEffect(() => setSaved(undefined), [device.outsideFilesOff]);
  const enabled = pending ?? saved ?? !device.outsideFilesOff;

  const save = async (next: boolean) => {
    setPending(next);
    setFailed(false);
    try {
      const result = await setDeviceOutsideFiles(device.id, next);
      setSaved(result.enabled);
      await onRefresh();
    } catch {
      setFailed(true);
    } finally {
      setPending(undefined);
    }
  };

  return (
    <section className="fdy-device-section" aria-busy={pending !== undefined}>
      <h2>{t("outsideFiles.title")}</h2>
      <label className="fdy-device-check">
        <Checkbox
          aria-describedby={hintId}
          checked={enabled}
          // aria-disabled, not disabled: keyboard focus stays on the box.
          aria-disabled={pending !== undefined || undefined}
          onChange={(event) => {
            if (pending === undefined) void save(event.currentTarget.checked);
          }}
        />
        <span>{t("outsideFiles.allow")}</span>
      </label>
      <FieldHint id={hintId}>
        {t("outsideFiles.hint", { device: device.label })}
      </FieldHint>
      {pending !== undefined ? (
        <p className="fdy-device-check-status" role="status">
          {t("outsideFiles.saving")}
        </p>
      ) : null}
      {failed ? (
        <Alert size="compact" tone="error" title={t("outsideFiles.failed")} />
      ) : null}
    </section>
  );
}
