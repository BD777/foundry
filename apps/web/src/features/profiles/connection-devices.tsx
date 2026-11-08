import { ToastFeedback, useToast } from "../../components/ui/toast";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  AgentProfileCheck,
  AgentProfileProjection,
  DeviceProfileBinding,
  DeviceProjection,
  ProfileDefinition,
  ProviderHealth,
} from "@bd777/foundry-protocol";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { Alert } from "../../components/ui/alert";
import { HelpHint } from "../../components/ui/help-hint";
import { SectionHeader } from "../../components/ui/page-header";
import { ConfirmButton } from "../../components/ui/confirm-button";
import { runtimeMeta } from "../../components/agent-runtime/runtime-mark";
import {
  RuntimeActionButton,
  RuntimeStateNote,
} from "../../components/devices/runtime-readiness";
import { connectionSelection, loopbackHost } from "../../lib/model-connections";
import {
  deviceReadiness,
  runtimesToInstall,
  type DeviceReadiness,
} from "../../lib/device-readiness";
import { installRuntime, useRuntimeInstalls } from "../../lib/runtime-installs";
import {
  ManagementRow,
  ManagementRowCopy,
} from "../../components/ui/management-row";
import { checkProfile } from "../../api";
import { quotaResetText } from "../../lib/profile-status";
import { clockTime } from "../../lib/time-format";

/** The latest check of a server provider on one device, from its projection row. */
export function serverProfileCheck(
  agentProfiles: AgentProfileProjection[],
  profileId: string,
  deviceId: string,
): AgentProfileCheck | undefined {
  return agentProfiles.find(
    (row) =>
      row.origin === "server" &&
      row.id === profileId &&
      row.deviceId === deviceId,
  )?.check;
}

/** The section of a profile editor that talks about devices (and the device that reads the catalog). */
export const connectionSectionClass =
  "grid min-w-0 gap-4 py-1 max-[700px]:p-3.5";

export function ConnectionDevices({
  devices,
  bindings,
  agentProfiles = [],
  profiles = [],
  providerHealth = [],
  profile,
  onSave,
  onRefresh,
}: {
  devices: DeviceProjection[];
  bindings: DeviceProfileBinding[];
  /** Every device's profile rows; a server provider's row carries its check there. */
  agentProfiles?: AgentProfileProjection[];
  /** Every server profile, to count what each device's runtime serves. */
  profiles?: ProfileDefinition[];
  providerHealth?: ProviderHealth[];
  profile: ProfileDefinition;
  onSave: (deviceId: string, profileIds: string[]) => Promise<unknown>;
  /** Rereads what the page shows, such as a check's stored result. */
  onRefresh: () => Promise<void>;
}) {
  const { t } = useTranslation("profiles");
  const { t: tDevices } = useTranslation("devices");
  const installs = useRuntimeInstalls();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const idPrefix = useId();
  const notify = useToast();
  const [checking, setChecking] = useState<string[]>([]);
  const [checkErrors, setCheckErrors] = useState<Record<string, string>>({});
  // Promoted from a provider at its device's own loopback address: no other
  // device reaches it, so it is offered only there (the server refuses too).
  const boundTo = profile.promotedFrom?.deviceBound
    ? profile.promotedFrom.deviceId
    : undefined;
  const name = runtimeMeta(profile.runtime).productName;

  async function save(
    device: DeviceProjection,
    enabled: boolean,
    readiness: DeviceReadiness,
  ): Promise<void> {
    setBusy(true);
    setError("");
    try {
      await onSave(
        device.id,
        connectionSelection(bindings, device.id, profile.id, enabled),
      );
      // Assigning is the intent to run it there: install its runtime now.
      if (enabled)
        for (const runtime of runtimesToInstall(readiness, [profile.runtime]))
          void installRuntime(device.id, runtime);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t("connectionDevices.updateFailed"),
      );
    } finally {
      setBusy(false);
    }
  }

  async function verify(device: DeviceProjection): Promise<void> {
    if (checking.includes(device.id)) return;
    setChecking((ids) => [...ids, device.id]);
    setCheckErrors((errors) => {
      const next = { ...errors };
      delete next[device.id];
      return next;
    });
    try {
      const result = await checkProfile(profile.id, device.id);
      await onRefresh();
      const names = { connection: profile.label, device: device.label };
      notify(
        result.status === "passed"
          ? {
              tone: "success",
              title: t("connectionDevices.checkPassed", names),
            }
          : result.reason === "quota_exhausted"
            ? {
                tone: "warning",
                title: t("connectionDevices.checkQuota", names),
                description: result.message,
              }
            : {
                tone: "error",
                title: t("connectionDevices.checkFailedNotice", names),
                description: result.message,
              },
      );
    } catch (cause) {
      const message =
        cause instanceof Error && cause.message
          ? cause.message
          : t("connectionDevices.checkRequestFailed");
      setCheckErrors((errors) => ({ ...errors, [device.id]: message }));
    } finally {
      setChecking((ids) => ids.filter((id) => id !== device.id));
    }
  }

  /** "Verified · 2:14 PM", "Check failed: …", "Not verified yet". */
  function checkState(check: AgentProfileCheck | undefined): string {
    if (!check) return t("connectionDevices.checkNone");
    if (check.status === "pending") return t("connectionDevices.checkPending");
    if (check.status === "passed")
      return check.checkedAt
        ? t("connectionDevices.checkPassedAt", {
            time: clockTime(check.checkedAt, { date: "short" }),
          })
        : t("connectionDevices.checkPassedState");
    if (check.reason === "quota_exhausted") {
      const reset = quotaResetText(check.message);
      return reset
        ? t("connectionDevices.checkQuotaResets", { reset })
        : t("connectionDevices.checkQuotaState");
    }
    return check.message
      ? t("connectionDevices.checkFailedReason", { reason: check.message })
      : t("connectionDevices.checkFailedState");
  }

  return (
    <section className={connectionSectionClass}>
      <SectionHeader
        level={3}
        title={t("connectionDevices.title")}
        description={t("connectionDevices.intro")}
        help={
          <HelpHint label={t("connectionDevices.helpLabel")}>
            {t("connectionDevices.help")}
          </HelpHint>
        }
      />
      {boundTo ? (
        <Alert
          role="status"
          size="compact"
          tone="warning"
          title={t("connectionDevices.deviceBound", {
            device:
              devices.find((device) => device.id === boundTo)?.label ?? boundTo,
            address: loopbackHost(profile.baseUrl) ?? profile.baseUrl,
          })}
        />
      ) : null}
      {!devices.length ? (
        <Alert size="compact" title={t("connectionDevices.noDevices")} />
      ) : null}
      {devices.map((device) => {
        const assigned = bindings.some(
          (row) =>
            row.deviceId === device.id &&
            row.profileId === profile.id &&
            row.enabled,
        );
        const unreachable = Boolean(boundTo) && device.id !== boundTo;
        const readiness = deviceReadiness({
          device,
          providerHealth,
          bindings,
          profiles,
          installs,
        });
        const installsOnAssign =
          runtimesToInstall(readiness, [profile.runtime]).length > 0;
        const online = device.status === "connected";
        const check = assigned
          ? serverProfileCheck(agentProfiles, profile.id, device.id)
          : undefined;
        const verifying = checking.includes(device.id);
        const checkError = checkErrors[device.id];
        const nameId = `${idPrefix}-${device.id}-name`;
        const checkId = `${idPrefix}-${device.id}-check`;
        return (
          <ManagementRow key={device.id}>
            <ManagementRowCopy>
              <strong id={nameId}>{device.label}</strong>
              <small>
                {device.status === "connected"
                  ? t("connectionDevices.online")
                  : t("connectionDevices.offline")}
              </small>
              <RuntimeStateNote
                assigned={assigned}
                device={device}
                readiness={readiness}
                runtime={profile.runtime}
              />
              {assigned ? (
                <small id={checkId}>
                  {verifying
                    ? t("connectionDevices.checkRunning")
                    : online
                      ? checkState(check)
                      : t("connectionDevices.checkOffline", {
                          state: checkState(check),
                        })}
                </small>
              ) : null}
              {assigned && checkError ? (
                <small role="alert" className="text-error-text">
                  {t("connectionDevices.checkError", { error: checkError })}
                </small>
              ) : null}
            </ManagementRowCopy>
            <Badge tone="neutral">
              {assigned
                ? t("connectionDevices.assigned")
                : t("connectionDevices.notAssigned")}
            </Badge>
            {assigned ? (
              <RuntimeActionButton
                device={device}
                readiness={readiness}
                row={readiness.runtimes[profile.runtime]}
              />
            ) : null}
            {/* A check sends a real conversation and uses quota, so the
                first click says so and the second one runs it. */}
            {assigned ? (
              <ConfirmButton
                busy={verifying}
                confirmLabel={t("connectionDevices.checkConfirm")}
                disabled={!online}
                onConfirm={() => void verify(device)}
                size="sm"
                variant="secondary"
                aria-describedby={`${nameId} ${checkId}`}
              >
                {verifying
                  ? t("connectionDevices.checking")
                  : check?.checkedAt
                    ? t("connectionDevices.checkAgain")
                    : t("connectionDevices.check")}
              </ConfirmButton>
            ) : null}
            {/* Granting access is a single click; removing it — a destructive
                change on another device — needs an explicit second click. */}
            {assigned ? (
              <ConfirmButton
                confirmLabel={t("connectionDevices.removeConfirm", {
                  connection: profile.label,
                  device: device.label,
                })}
                disabled={busy}
                onConfirm={() => void save(device, false, readiness)}
                size="sm"
                variant="secondary"
                aria-label={t("connectionDevices.removeLabel", {
                  connection: profile.label,
                  device: device.label,
                })}
              >
                {t("connectionDevices.removeAccess")}
              </ConfirmButton>
            ) : unreachable ? null : (
              <Button
                disabled={busy}
                size="sm"
                variant="secondary"
                aria-label={
                  installsOnAssign
                    ? tDevices("readiness.assign.andInstallLabel", {
                        connection: profile.label,
                        device: device.label,
                        name,
                      })
                    : t("connectionDevices.assignLabel", {
                        connection: profile.label,
                        device: device.label,
                      })
                }
                onClick={() => void save(device, true, readiness)}
              >
                {installsOnAssign
                  ? tDevices("readiness.assign.andInstall", { name })
                  : t("connectionDevices.assign")}
              </Button>
            )}
          </ManagementRow>
        );
      })}
      {error ? <ToastFeedback tone="error" title={error} /> : null}
    </section>
  );
}
