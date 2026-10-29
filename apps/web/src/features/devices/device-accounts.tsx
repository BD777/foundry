import { ToastFeedback } from "../../components/ui/toast";
import { FieldHint } from "../../components/ui/field";
import { AgentRuntimeUpdateNotice } from "./agent-runtime-update-notice";
import { AgentRuntimeStatus } from "./agent-runtime-status";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  AgentProfileProjection,
  DeviceProjection,
  ProfileDefinition,
  DeviceProfileBinding,
  ProviderHealth,
} from "@bd777/foundry-protocol";
import { inspectDeviceAccount, resumeNativeAccount } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { RuntimeMark, runtimeMeta } from "../../components/ui/runtime-mark";
import { isModelConnection } from "../../lib/model-connections";
import { DeviceAccountDefaults } from "./device-account-defaults";
import { AccountInspection } from "./account-inspection";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  deviceReadiness,
  memoryLabel,
  runtimeInstallKey,
} from "../../lib/device-readiness";
import { installRuntime, useRuntimeInstalls } from "../../lib/runtime-installs";
import {
  InstallAllButton,
  RuntimeActionButton,
  runtimeReadinessText,
} from "../../components/devices/runtime-readiness";
import { useSharedNow } from "../../lib/use-shared-now";

export function DeviceAccounts({
  device,
  profiles,
  health,
  legacyProfiles,
  bindings,
  serverProfiles = [],
  onRefresh,
}: {
  device: DeviceProjection;
  profiles: AgentProfileProjection[];
  health: ProviderHealth[];
  legacyProfiles: ProfileDefinition[];
  bindings: DeviceProfileBinding[];
  /** Server model providers, to tell which runtimes assigned ones need. */
  serverProfiles?: ProfileDefinition[];
  onRefresh: () => Promise<void>;
}) {
  const { t } = useTranslation("profiles");
  const { t: tDevices } = useTranslation("devices");
  const installs = useRuntimeInstalls();
  const readiness = deviceReadiness({
    device,
    providerHealth: health.map((row) => ({
      ...row,
      deviceId: row.deviceId ?? device.id,
    })),
    bindings,
    profiles: serverProfiles,
    installs,
  });
  const now = useSharedNow(
    Object.values(readiness.runtimes).some(
      (row) => row.state === "installing" || row.state === "updating",
    ),
  );
  const [checking, setChecking] = useState<"claude" | "codex">();
  const [error, setError] = useState("");
  const [resuming, setResuming] = useState<string>();
  // The install's progress and outcome live in the shared install store, so
  // one started from a chat or the Model providers page shows here too.
  async function installCli(runtime: "claude" | "codex"): Promise<void> {
    setError("");
    await installRuntime(device.id, runtime);
    await onRefresh().catch(() => {});
  }
  const installing = Object.values(readiness.runtimes).some(
    (row) => row.state === "installing" || row.state === "updating",
  );
  const [expanded, setExpanded] = useState<string>();
  // Signing in happens on the device, in the agent's own CLI; Foundry then
  // reads the login it finds there.
  async function checkLogin(runtime: "claude" | "codex"): Promise<void> {
    setChecking(runtime);
    setError("");
    try {
      await inspectDeviceAccount(device.id, runtime);
      await onRefresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("accounts.checkFailed"),
      );
    } finally {
      setChecking(undefined);
    }
  }
  const legacy = legacyProfiles.filter(
    (profile) => !isModelConnection(profile),
  );
  return (
    <section className="fdy-device-section fdy-account-list">
      {/* With no swap, the device page's swap notice says it, with the fix. */}
      {readiness.lowMemory && readiness.memoryBytes && !readiness.noSwap ? (
        <Alert tone="warning" title={tDevices("readiness.memory.title")}>
          {tDevices("readiness.memory.low", {
            device: device.label,
            memory: memoryLabel(readiness.memoryBytes),
          })}
        </Alert>
      ) : null}
      <InstallAllButton device={device} readiness={readiness} />
      {(["claude", "codex"] as const).map((runtime) => {
        const local = profiles.find(
          (profile) =>
            profile.origin === "device" &&
            profile.runtime === runtime &&
            profile.connectionType === "local_login",
        );
        const nativeHealth = health.find((row) => row.provider === runtime);
        const status = local?.status ?? nativeHealth?.status;
        const hold = local?.accountHold;
        const signedIn = !!local && status === "healthy";
        const unavailable = status === "unavailable";
        const name = runtimeMeta(runtime).productName;
        const cli = nativeHealth?.cli;
        const missing = cli?.installed === false;
        const online = device.status === "connected";
        const ready = readiness.runtimes[runtime];
        const busy = ready.state === "installing" || ready.state === "updating";
        const failed = ready.state === "install_failed";
        const attempt = installs.get(runtimeInstallKey(device.id, runtime));
        return (
          <div className="fdy-device-account" key={runtime}>
            <div className="fdy-account-row">
              <RuntimeMark runtime={runtime} size="lg" />
              <Button
                variant="ghost"
                className="fdy-account-open"
                aria-expanded={expanded === runtime}
                onClick={() =>
                  setExpanded(expanded === runtime ? undefined : runtime)
                }
              >
                <span className="fdy-account-name">
                  <strong>{name}</strong>
                  <small>
                    {hold
                      ? t("accounts.suspended")
                      : signedIn
                        ? t("accounts.localLoginDetected")
                        : busy || failed || missing
                          ? runtimeReadinessText(
                              tDevices,
                              ready,
                              device.label,
                              now,
                            )
                          : unavailable
                            ? (local?.statusDetail ??
                              nativeHealth?.statusDetail ??
                              t("accounts.installNative"))
                            : t("accounts.noLogin")}
                  </small>
                </span>
                <span className="fdy-account-open-label">
                  {t("accounts.accountAndDefaults")}
                </span>
                {expanded === runtime ? (
                  <ChevronDown size={15} />
                ) : (
                  <ChevronRight size={15} />
                )}
              </Button>
              <Badge
                tone={device.status !== "connected" ? "neutral" : "neutral"}
              >
                {device.status !== "connected"
                  ? t("accounts.deviceOffline")
                  : hold
                    ? t("accounts.suspended")
                    : busy
                      ? tDevices("readiness.summary.installing")
                      : signedIn
                        ? t("accounts.localLogin")
                        : missing
                          ? t("accounts.notInstalled")
                          : unavailable
                            ? t("accounts.unavailable")
                            : t("accounts.workerNoLogin")}
              </Badge>
              {busy ? null : missing ? (
                <RuntimeActionButton
                  device={device}
                  readiness={readiness}
                  row={ready}
                />
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!online || checking !== undefined}
                  aria-busy={checking === runtime}
                  aria-label={t("accounts.checkAgainLabel", {
                    name,
                    device: device.label,
                  })}
                  busy={checking === runtime}
                  onClick={() => void checkLogin(runtime)}
                >
                  {checking === runtime
                    ? t("accounts.checking")
                    : t("accounts.checkAgain")}
                </Button>
              )}
            </div>
            {!signedIn && !hold && !missing && online ? (
              <FieldHint>
                {t(
                  runtime === "claude"
                    ? "accounts.signInHintClaude"
                    : "accounts.signInHintCodex",
                  { device: device.label },
                )}
              </FieldHint>
            ) : null}
            {hold && local ? (
              <Alert tone="warning" title={t("accounts.suspended")}>
                <p>
                  {t("accounts.suspendedDetail", {
                    account: hold.accountLabel,
                    at: new Date(hold.observedAt).toLocaleString(),
                  })}
                </p>
                <FieldHint>{t("accounts.resumeHint")}</FieldHint>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={resuming !== undefined}
                  aria-busy={resuming === local.id}
                  onClick={async () => {
                    setResuming(local.id);
                    setError("");
                    try {
                      await resumeNativeAccount(device.id, local.id, hold.id);
                      await onRefresh();
                    } catch (cause) {
                      setError(
                        cause instanceof Error
                          ? cause.message
                          : t("accounts.resumeFailed"),
                      );
                    } finally {
                      setResuming(undefined);
                    }
                  }}
                >
                  {resuming === local.id
                    ? t("accounts.resuming")
                    : t("accounts.resume")}
                </Button>
              </Alert>
            ) : null}
            {missing && online && !busy ? (
              <FieldHint>
                {t("accounts.installCliHint", { device: device.label })}
              </FieldHint>
            ) : null}
            {failed ? (
              <Alert
                tone="error"
                title={t("accounts.installCliFailed", {
                  name,
                  device: device.label,
                })}
                details={
                  ready.log?.trim() ? (
                    <pre className="fdy-device-account-log">{ready.log}</pre>
                  ) : undefined
                }
              >
                {ready.detail}
              </Alert>
            ) : null}
            {cli?.installed && attempt?.state === "failed" ? (
              <Alert
                tone="error"
                title={t("accounts.runtimeChangeFailed", { name })}
                details={
                  attempt.log?.trim() ? (
                    <pre className="fdy-device-account-log">{attempt.log}</pre>
                  ) : undefined
                }
              >
                {attempt.detail}
              </Alert>
            ) : null}
            {cli?.installed ? (
              <AgentRuntimeUpdateNotice
                cli={cli}
                name={name}
                online={online}
                busy={installing}
                onUpdate={() => void installCli(runtime)}
              />
            ) : null}
            {expanded === runtime ? (
              <div className="fdy-account-expanded">
                {cli?.installed ? (
                  <AgentRuntimeStatus
                    cli={cli}
                    online={online}
                    busy={installing}
                    onCheck={() => void installCli(runtime)}
                  />
                ) : null}
                <AccountInspection
                  key={local?.runtimeGeneration ?? cli?.generation ?? runtime}
                  identity={local?.runtimeGeneration ?? cli?.generation}
                  deviceId={device.id}
                  runtime={runtime}
                  online={device.status === "connected"}
                  onChecked={onRefresh}
                />
                {local ? (
                  <DeviceAccountDefaults
                    key={local.id}
                    device={device}
                    profile={local}
                    onRefresh={onRefresh}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
      {error ? <ToastFeedback tone="error" title={error} /> : null}
      {legacy.length ? (
        <details className="fdy-device-legacy">
          <summary className="fdy-device-disclosure">
            {t("accounts.legacyTitle", { count: legacy.length })}
          </summary>
          <p>{t("accounts.legacyIntro")}</p>
          <div className="fdy-management-list">
            {legacy.map((profile) => (
              <div key={profile.id} className="fdy-management-row">
                <span>
                  <strong>{profile.label}</strong>
                  <small>
                    {profile.runtime} ·{" "}
                    {profile.model || t("accounts.runtimeDefault")} ·{" "}
                    {bindings.some(
                      (row) =>
                        row.deviceId === device.id &&
                        row.profileId === profile.id &&
                        row.enabled,
                    )
                      ? t("accounts.previouslyAssigned")
                      : t("accounts.notAssigned")}
                  </small>
                </span>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}
