import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DeviceProjection } from "@bd777/foundry-protocol";
import { setDeviceOutsideFiles } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Checkbox, FieldHint } from "../../components/ui/field";
import { HelpHint } from "../../components/ui/help-hint";
import { SectionHeader } from "../../components/ui/page-header";
import { DeviceSection } from "./device-section";

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
    <DeviceSection aria-busy={pending !== undefined}>
      <SectionHeader
        title={t("outsideFiles.title")}
        help={
          <HelpHint label={t("outsideFiles.helpLabel")}>
            {t("outsideFiles.help")}
          </HelpHint>
        }
      />
      <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
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
        <p className="m-0 text-xs text-ink-muted" role="status">
          {t("outsideFiles.saving")}
        </p>
      ) : null}
      {failed ? (
        <Alert size="compact" tone="error" title={t("outsideFiles.failed")} />
      ) : null}
    </DeviceSection>
  );
}
