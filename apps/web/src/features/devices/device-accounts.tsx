import { ToastFeedback } from "../../components/ui/toast";
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
import { HelpHint } from "../../components/ui/help-hint";
import {
  RuntimeMark,
  runtimeMeta,
} from "../../components/agent-runtime/runtime-mark";
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
import {
  ManagementList,
  ManagementRow,
  ManagementRowCopy,
} from "../../components/ui/management-row";
import { DeviceSection } from "./device-section";

const accountLogClass =
  "m-0 max-h-60 overflow-auto text-2xs whitespace-pre-wrap";

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
    <DeviceSection className="gap-0">
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
          <div className="grid gap-0 border-b border-line" key={runtime}>
            <div className="flex min-w-0 items-center gap-3 py-4 max-[700px]:flex-wrap max-[700px]:gap-2">
              <RuntimeMark runtime={runtime} size="lg" />
              <Button
                variant="ghost"
                className="-ml-2 h-auto flex-1 justify-start gap-3 rounded-lg border-0 p-2 text-left whitespace-normal active:scale-100 focus-visible:outline-0 focus-visible:shadow-[inset_0_0_0_1px_var(--fdy-control-focus)] max-[700px]:basis-[70%]"
                aria-expanded={expanded === runtime}
                onClick={() =>
                  setExpanded(expanded === runtime ? undefined : runtime)
                }
              >
                <span className="grid min-w-0 flex-1 gap-1.5">
                  <strong className="text-md">{name}</strong>
                  <small className="text-xs leading-[1.5] font-normal text-ink-muted">
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
                <span className="text-2xs font-normal text-ink-muted max-[1000px]:hidden">
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
                <>
                  <RuntimeActionButton
                    device={device}
                    readiness={readiness}
                    row={ready}
                  />
                  {online ? (
                    <HelpHint
                      label={t("accounts.installCliHelpLabel", { name })}
                    >
                      {t("accounts.installCliHint", { device: device.label })}
                    </HelpHint>
                  ) : null}
                </>
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
              <Alert
                className="mb-3"
                size="compact"
                title={t("accounts.notSignedIn")}
              >
                {t(
                  runtime === "claude"
                    ? "accounts.signInHintClaude"
                    : "accounts.signInHintCodex",
                  { device: device.label },
                )}
              </Alert>
            ) : null}
            {hold && local ? (
              <Alert
                className="mb-3"
                tone="warning"
                title={t("accounts.suspended")}
                actions={
                  <>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={resuming !== undefined}
                      aria-busy={resuming === local.id}
                      onClick={async () => {
                        setResuming(local.id);
                        setError("");
                        try {
                          await resumeNativeAccount(
                            device.id,
                            local.id,
                            hold.id,
                          );
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
                    <HelpHint label={t("accounts.resumeHelpLabel")}>
                      {t("accounts.resumeHint")}
                    </HelpHint>
                  </>
                }
              >
                {t("accounts.suspendedDetail", {
                  account: hold.accountLabel,
                  at: new Date(hold.observedAt).toLocaleString(),
                })}
              </Alert>
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
                    <pre className={accountLogClass}>{ready.log}</pre>
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
                    <pre className={accountLogClass}>{attempt.log}</pre>
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
              <div className="grid grid-cols-2 gap-7 pt-2 pb-6.5 max-[1000px]:grid-cols-1">
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
        <details>
          <summary className="cursor-pointer rounded-xs py-2.5 text-sm text-ink-muted hover:bg-control-ghost-hover focus-visible:outline-1 focus-visible:outline-offset-3 focus-visible:outline-brand">
            {t("accounts.legacyTitle", { count: legacy.length })}
          </summary>
          <Alert
            className="my-1.5"
            size="compact"
            title={t("accounts.legacyNotice")}
          />
          <ManagementList>
            {legacy.map((profile) => (
              <ManagementRow key={profile.id}>
                <ManagementRowCopy>
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
                </ManagementRowCopy>
              </ManagementRow>
            ))}
          </ManagementList>
        </details>
      ) : null}
    </DeviceSection>
  );
}
