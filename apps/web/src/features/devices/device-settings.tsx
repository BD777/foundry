import { ToastFeedback } from "../../components/ui/toast";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DeviceProjection } from "@bd777/foundry-protocol";
import { saveAgentRuntimeSettings } from "../../api";
import { Button } from "../../components/ui/button";
import { FieldHint, TextInput } from "../../components/ui/field";
import { HelpHint } from "../../components/ui/help-hint";
import { SectionHeader } from "../../components/ui/page-header";
import { DeviceSection, deviceActionsClass } from "./device-section";

export function DeviceSettings({
  device,
  onRefresh,
  onRemoveDevice,
}: {
  device: DeviceProjection;
  onRefresh: () => Promise<void>;
  onRemoveDevice: () => void;
}) {
  const settings = device.runtimeSettings;
  const [draft, setDraft] = useState({
    activeRuntimeTtlMs: settings?.activeRuntimeTtlMs ?? 900000,
    maxConcurrentTasks: settings?.maxConcurrentTasks ?? 4,
  });
  // Saving without the owner's number keeps the hardware default (DEV-084).
  const hardware = settings?.hardwareMaxConcurrentTasks;
  const [useHardware, setUseHardware] = useState(
    settings?.maxConcurrentTasksSource === "hardware",
  );
  const { t } = useTranslation("devices");
  const maxTasksId = useId();
  const maxTasksHint = useId();
  const keepAliveHint = useId();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"success" | "error">(
    "success",
  );
  return (
    <DeviceSection>
      <SectionHeader
        title={t("settings.title")}
        description={t("settings.intro", { device: device.label })}
      />
      <div className="flex flex-wrap gap-5">
        <div className="grid max-w-[340px] content-start justify-items-start gap-2">
          <div className="grid gap-2 text-sm">
            <div className="flex items-center gap-1.5">
              <label htmlFor={maxTasksId}>{t("settings.maxTasks")}</label>
              <HelpHint label={t("settings.maxTasksHelpLabel")}>
                {t("settings.maxTasksHelp")}
              </HelpHint>
            </div>
            <TextInput
              id={maxTasksId}
              tone="boxed"
              aria-describedby={
                hardware !== undefined ? maxTasksHint : undefined
              }
              type="number"
              min={1}
              max={16}
              value={draft.maxConcurrentTasks}
              onChange={(event) => {
                setUseHardware(false);
                setDraft({
                  ...draft,
                  maxConcurrentTasks: Number(event.currentTarget.value),
                });
              }}
            />
          </div>
          {hardware !== undefined ? (
            <FieldHint id={maxTasksHint}>
              {useHardware
                ? t(
                    hardware === 1
                      ? "settings.maxTasksSmallDevice"
                      : "settings.maxTasksHardware",
                    {
                      count: hardware,
                      memory: settings?.hardware?.memoryGiB ?? "?",
                      cpus: settings?.hardware?.cpus ?? "?",
                    },
                  )
                : t("settings.maxTasksOwner", { count: hardware })}
            </FieldHint>
          ) : null}
          {hardware !== undefined && !useHardware ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setUseHardware(true);
                setDraft({ ...draft, maxConcurrentTasks: hardware });
              }}
            >
              {t("settings.useHardwareDefault", { count: hardware })}
            </Button>
          ) : null}
        </div>
        <div className="grid max-w-[340px] content-start justify-items-start gap-2">
          <label className="grid gap-2 text-sm">
            {t("settings.runtimeCache")}
            <TextInput
              tone="boxed"
              aria-label={t("settings.runtimeCacheLabel")}
              aria-describedby={keepAliveHint}
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
          <FieldHint id={keepAliveHint}>
            {t("settings.runtimeCacheHint")}
          </FieldHint>
        </div>
      </div>
      <div className={deviceActionsClass}>
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
            setMessageTone("success");
            try {
              await saveAgentRuntimeSettings({
                deviceId: device.id,
                settings: {
                  ...draft,
                  maxConcurrentTasks: useHardware
                    ? 0
                    : draft.maxConcurrentTasks,
                },
              });
              await onRefresh();
              setMessage(t("settings.saved"));
            } catch (cause) {
              setMessageTone("error");
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
        {message ? <ToastFeedback tone={messageTone} title={message} /> : null}
      </div>

      <section
        className="mt-7 border-t border-line pt-5"
        aria-labelledby="fdy-device-removal-heading"
      >
        <SectionHeader
          title={t("settings.removeTitle")}
          titleId="fdy-device-removal-heading"
          description={t("settings.removeBody", { device: device.label })}
          actions={
            <Button size="sm" variant="ghost" onClick={onRemoveDevice}>
              {t("list.removeFromFoundry")}
            </Button>
          }
        />
      </section>
    </DeviceSection>
  );
}
