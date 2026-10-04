import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { DeviceProjection } from "@bd777/foundry-protocol";
import { saveAgentRuntimeSettings } from "../../api";
import { Button } from "../../components/ui/button";
import { TextInput } from "../../components/ui/field";

export function DeviceSettings({
  device,
  onRefresh,
  onRemoveDevice,
}: {
  device: DeviceProjection;
  onRefresh: () => Promise<void>;
  onRemoveDevice: () => void;
}) {
  const [draft, setDraft] = useState(
    device.runtimeSettings ?? {
      activeRuntimeTtlMs: 900000,
      maxConcurrentTasks: 4,
    },
  );
  const { t } = useTranslation("devices");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  return (
    <section className="fdy-device-section">
      <h2>{t("settings.title")}</h2>
      <p>{t("settings.intro", { device: device.label })}</p>
      <div className="fdy-device-settings-fields">
        <label>
          {t("settings.maxTasks")}
          <TextInput
            tone="boxed"
            aria-label={t("settings.maxTasks")}
            type="number"
            min={1}
            max={16}
            value={draft.maxConcurrentTasks}
            onChange={(event) =>
              setDraft({
                ...draft,
                maxConcurrentTasks: Number(event.currentTarget.value),
              })
            }
          />
        </label>
        <label>
          {t("settings.runtimeCache")}
          <TextInput
            tone="boxed"
            aria-label={t("settings.runtimeCacheLabel")}
            type="number"
            min={1}
            value={draft.activeRuntimeTtlMs / 60000}
            onChange={(event) =>
              setDraft({
                ...draft,
                activeRuntimeTtlMs: Number(event.currentTarget.value) * 60000,
              })
            }
          />
        </label>
      </div>
      <div className="fdy-device-settings-actions">
        <Button
          disabled={
            busy ||
            device.status !== "connected" ||
            !Number.isInteger(draft.maxConcurrentTasks) ||
            draft.maxConcurrentTasks < 1 ||
            draft.maxConcurrentTasks > 16 ||
            !Number.isFinite(draft.activeRuntimeTtlMs) ||
            draft.activeRuntimeTtlMs < 60000
          }
          size="sm"
          variant="primary"
          onClick={async () => {
            setBusy(true);
            setMessage("");
            try {
              await saveAgentRuntimeSettings({
                deviceId: device.id,
                settings: draft,
              });
              await onRefresh();
              setMessage(t("settings.saved"));
            } catch (cause) {
              setMessage(
                cause instanceof Error
                  ? cause.message
                  : t("settings.saveFailed"),
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("settings.save")}
        </Button>
        {message ? <p role="status">{message}</p> : null}
      </div>

      <section
        className="fdy-device-removal-zone"
        aria-labelledby="fdy-device-removal-heading"
      >
        <h3 id="fdy-device-removal-heading">{t("settings.removeTitle")}</h3>
        <p>{t("settings.removeBody", { device: device.label })}</p>
        <Button size="sm" variant="ghost" onClick={onRemoveDevice}>
          {t("list.removeFromFoundry")}
        </Button>
      </section>
    </section>
  );
}
