import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type {
  DeviceProjection,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { saveAgentRuntimeSettings } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { FieldHint, TextInput } from "../../components/ui/field";
import { InfoRow } from "../../components/ui/info-row";
import { SectionHeader } from "../../components/ui/page-header";
import { Switch } from "../../components/ui/switch";
import { ToastFeedback } from "../../components/ui/toast";
import {
  deviceConcurrencyLimit,
  deviceConcurrencyMode,
} from "../../lib/device-concurrency";
import { formatBytes } from "../../lib/format";
import { deviceConnection } from "../../lib/device-connection";
import { DeviceSection, deviceActionsClass } from "./device-section";

function memoryPair(
  available: number | undefined,
  total: number | undefined,
): string | undefined {
  const format = (value: number) =>
    formatBytes(value, {
      gb: true,
      mbDigits: "adaptive",
      trimZeros: true,
    });
  if (available !== undefined && total !== undefined)
    return `${format(available)} / ${format(total)}`;
  if (available !== undefined) return format(available);
  return undefined;
}

function workspaceEstimateLabel(
  workspaceId: string | undefined,
  workspaces: WorkspaceProjection[],
  unknownWorkspace: string,
  unknownWorkspaceWithId: (id: string) => string,
): string {
  const workspace = workspaces.find((row) => row.id === workspaceId);
  if (workspace?.name) return workspace.name;
  if (!workspaceId) return unknownWorkspace;
  return unknownWorkspaceWithId(workspaceId.slice(0, 11));
}

function migrationDismissalKey(deviceId: string): string {
  return `foundry:device:${deviceId}:adaptive-migration-dismissed`;
}

function migrationWasDismissed(deviceId: string): boolean {
  try {
    return window.localStorage.getItem(migrationDismissalKey(deviceId)) === "1";
  } catch {
    return false;
  }
}

function dismissMigration(deviceId: string): void {
  try {
    window.localStorage.setItem(migrationDismissalKey(deviceId), "1");
  } catch {
    // The notice stays dismissed for this mount when storage is unavailable.
  }
}

export function DeviceSettings({
  device,
  workspaces = [],
  onRefresh,
  onRemoveDevice,
}: {
  device: DeviceProjection;
  workspaces?: WorkspaceProjection[];
  onRefresh: () => Promise<void>;
  onRemoveDevice: () => void;
}) {
  const settings = device.runtimeSettings;
  const runtime = device.runtimeState;
  const savedMode = settings?.mode === "forced" ? "forced" : "adaptive";
  const [forced, setForced] = useState(savedMode === "forced");
  const [draft, setDraft] = useState({
    activeRuntimeTtlMs: settings?.activeRuntimeTtlMs ?? 900000,
    forcedLimit:
      settings?.forcedLimit ??
      settings?.maxConcurrentTasks ??
      runtime?.limit ??
      4,
  });
  const [migrationDismissed, setMigrationDismissed] = useState(() =>
    migrationWasDismissed(device.id),
  );
  const { t } = useTranslation("devices");
  const forcedSwitchId = useId();
  const forcedLimitId = useId();
  const forcedLimitHintId = useId();
  const keepAliveHintId = useId();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"success" | "error">(
    "success",
  );
  const currentMode = deviceConcurrencyMode(device);
  const currentLimit = deviceConcurrencyLimit(device);
  const limitedRunning = runtime?.runningLimited ?? runtime?.running ?? 0;
  const limitedQueued = runtime?.queuedLimited ?? runtime?.queued ?? 0;
  const exemptRunning = runtime?.runningExempt ?? 0;
  const exemptQueued = runtime?.queuedExempt ?? 0;
  const forcedLimitInvalid =
    !Number.isInteger(draft.forcedLimit) ||
    draft.forcedLimit < 1 ||
    draft.forcedLimit > 16;
  const keepAliveInvalid =
    !Number.isFinite(draft.activeRuntimeTtlMs) ||
    draft.activeRuntimeTtlMs < 60000;
  const showMigration =
    settings?.migrationNotice === "adaptive_migrated" && !migrationDismissed;
  const cpuCount = runtime?.signals.cpuCount ?? settings?.hardware?.cpus;
  const memory = memoryPair(
    runtime?.signals.memoryAvailableBytes,
    runtime?.signals.memoryTotalBytes,
  );
  const cpuPressure = runtime?.signals.cpuPressurePercent;
  const estimates = runtime?.estimates ?? [];

  return (
    <DeviceSection>
      <SectionHeader
        title={t("settings.title")}
        description={t("settings.intro", { device: device.label })}
      />

      {showMigration ? (
        <Alert
          title={t("settings.migrationTitle")}
          actions={
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                dismissMigration(device.id);
                setMigrationDismissed(true);
              }}
            >
              {t("settings.dismiss")}
            </Button>
          }
        >
          {t("settings.migrationBody")}
        </Alert>
      ) : null}

      {runtime?.hardHold ? (
        <Alert tone="error" title={t("settings.hardHoldTitle")}>
          {t("settings.hardHoldBody")}
        </Alert>
      ) : null}

      <div className="grid min-w-0 gap-4 border-y border-line-soft py-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="m-0 text-md font-semibold text-ink">
            {t("settings.liveTitle")}
          </h3>
          <Badge tone={currentMode === "forced" ? "warn" : "slate"}>
            {t(`settings.mode.${currentMode}`)}
          </Badge>
          {runtime ? (
            <span className="text-xs text-ink-faint">
              {t("settings.sampledAt", {
                time: new Date(runtime.capturedAt).toLocaleTimeString(),
              })}
            </span>
          ) : null}
        </div>
        <dl className="m-0 grid grid-cols-4 gap-4 max-[900px]:grid-cols-2 max-[480px]:grid-cols-1">
          <Fact label={t("settings.currentLimit")}>{currentLimit ?? "—"}</Fact>
          <Fact label={t("settings.limitedTurns")}>
            {runtime
              ? t("settings.turnLoad", {
                  running: limitedRunning,
                  queued: limitedQueued,
                })
              : "—"}
          </Fact>
          <Fact label={t("settings.exemptTurns")}>
            {runtime
              ? t("settings.turnLoad", {
                  running: exemptRunning,
                  queued: exemptQueued,
                })
              : "—"}
          </Fact>
          <Fact label={t("settings.cpuCores")}>{cpuCount ?? "—"}</Fact>
        </dl>
        {runtime ? (
          <div className="grid gap-2">
            <h4 className="m-0 text-xs font-semibold text-ink">
              {t("settings.basisTitle")}
            </h4>
            <dl className="m-0 grid grid-cols-3 gap-4 max-[700px]:grid-cols-1">
              <Fact label={t("settings.memory")}>{memory ?? "—"}</Fact>
              <Fact label={t("settings.cpuPressure")}>
                {cpuPressure === undefined
                  ? "—"
                  : t("settings.percent", {
                      value: Math.round(cpuPressure),
                    })}
              </Fact>
              <Fact label={t("settings.memoryPressure")}>
                {runtime.signals.memoryPressurePercent === undefined
                  ? "—"
                  : t("settings.percent", {
                      value: Math.round(runtime.signals.memoryPressurePercent),
                    })}
              </Fact>
            </dl>
          </div>
        ) : (
          <FieldHint className="m-0">{t("settings.liveUnavailable")}</FieldHint>
        )}
        {runtime ? (
          <div className="grid min-w-0 gap-1">
            <h4 className="m-0 text-xs font-semibold text-ink">
              {t("settings.estimatesTitle")}
            </h4>
            {estimates.length ? (
              <div className="grid min-w-0">
                {estimates.map((estimate) => {
                  return (
                    <InfoRow
                      key={`${estimate.workspaceId ?? ""}:${estimate.runtime ?? ""}`}
                      density="compact"
                      variant="keyValue"
                      label={
                        estimate.source === "prior"
                          ? t("settings.defaultEstimate")
                          : workspaceEstimateLabel(
                              estimate.workspaceId,
                              workspaces,
                              t("settings.unknownWorkspace"),
                              (id) =>
                                t("settings.unknownWorkspaceWithId", { id }),
                            )
                      }
                      meta={t("settings.estimateMeta", {
                        runtime:
                          estimate.runtime || t("settings.unknownRuntime"),
                        typical: formatBytes(estimate.typicalRssBytes, {
                          gb: true,
                          mbDigits: "adaptive",
                          trimZeros: true,
                        }),
                        peak: formatBytes(estimate.peakRssBytes, {
                          gb: true,
                          mbDigits: "adaptive",
                          trimZeros: true,
                        }),
                      })}
                    >
                      {t("settings.estimateCpu", {
                        cpu: estimate.averageCpuCores.toFixed(1),
                      })}
                    </InfoRow>
                  );
                })}
              </div>
            ) : (
              <FieldHint className="m-0">{t("settings.noEstimates")}</FieldHint>
            )}
          </div>
        ) : null}
      </div>

      <div className="grid min-w-0 gap-3">
        <div className="flex min-w-0 items-start justify-between gap-4">
          <div className="grid min-w-0 gap-1">
            <label
              className="text-sm font-semibold text-ink"
              htmlFor={forcedSwitchId}
            >
              {t("settings.forcedToggle")}
            </label>
            <FieldHint className="m-0">
              {forced ? t("settings.forcedHelp") : t("settings.adaptiveHelp")}
            </FieldHint>
          </div>
          <Switch
            id={forcedSwitchId}
            checked={forced}
            onCheckedChange={setForced}
          />
        </div>
        {forced ? (
          <div className="grid max-w-[220px] gap-2">
            <label className="grid gap-2 text-sm" htmlFor={forcedLimitId}>
              {t("settings.forcedLimit")}
              <TextInput
                id={forcedLimitId}
                tone="boxed"
                type="number"
                inputMode="numeric"
                min={1}
                max={16}
                value={draft.forcedLimit}
                aria-invalid={forcedLimitInvalid || undefined}
                aria-describedby={forcedLimitHintId}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    forcedLimit: Number(event.currentTarget.value),
                  })
                }
              />
            </label>
            <FieldHint
              id={forcedLimitHintId}
              className="m-0"
              tone={forcedLimitInvalid ? "error" : "muted"}
            >
              {forcedLimitInvalid
                ? t("settings.invalidForcedLimit")
                : t("settings.forcedLimitHint")}
            </FieldHint>
          </div>
        ) : null}
        {forced ? (
          <Alert tone="warning" title={t("settings.forcedWarningTitle")}>
            {t("settings.forcedWarning")}
          </Alert>
        ) : null}
      </div>

      <div className="grid max-w-[340px] content-start justify-items-start gap-2">
        <label className="grid w-full gap-2 text-sm">
          {t("settings.runtimeCache")}
          <TextInput
            tone="boxed"
            aria-label={t("settings.runtimeCacheLabel")}
            aria-describedby={keepAliveHintId}
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
        <FieldHint id={keepAliveHintId} className="m-0">
          {t("settings.runtimeCacheHint")}
        </FieldHint>
      </div>

      <div className={deviceActionsClass}>
        <Button
          disabled={
            busy ||
            deviceConnection(device) !== "online" ||
            keepAliveInvalid ||
            (forced && forcedLimitInvalid)
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
                  activeRuntimeTtlMs: draft.activeRuntimeTtlMs,
                  mode: forced ? "forced" : "adaptive",
                  ...(forced ? { forcedLimit: draft.forcedLimit } : {}),
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

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="m-0 mt-1 text-lg font-[650] text-ink">{children}</dd>
    </div>
  );
}
