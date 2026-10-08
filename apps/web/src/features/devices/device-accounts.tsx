import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  AgentProfileProjection,
  DeviceProjection,
  ProfileDefinition,
  DeviceProfileBinding,
  ProviderHealth,
} from "@bd777/foundry-protocol";
import { inspectDeviceAccount, installDeviceCli } from "../../api";
import type { NativeCliInstallResult } from "@bd777/foundry-protocol";
import { Alert } from "../../components/ui/alert";
import { ConfirmButton } from "../../components/ui/confirm-button";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { RuntimeMark } from "../../components/ui/runtime-mark";
import { isModelConnection } from "../../lib/model-connections";
import { DeviceAccountDefaults } from "./device-account-defaults";
import { AccountInspection } from "./account-inspection";
import { ChevronDown, ChevronRight } from "lucide-react";

export function DeviceAccounts({
  device,
  profiles,
  health,
  legacyProfiles,
  bindings,
  onRefresh,
}: {
  device: DeviceProjection;
  profiles: AgentProfileProjection[];
  health: ProviderHealth[];
  legacyProfiles: ProfileDefinition[];
  bindings: DeviceProfileBinding[];
  onRefresh: () => Promise<void>;
}) {
  const { t } = useTranslation("profiles");
  const [checking, setChecking] = useState<"claude" | "codex">();
  const [error, setError] = useState("");
  const [installing, setInstalling] = useState<"claude" | "codex">();
  const [installed, setInstalled] = useState<NativeCliInstallResult>();
  async function installCli(runtime: "claude" | "codex"): Promise<void> {
    setInstalling(runtime);
    setInstalled(undefined);
    setError("");
    try {
      setInstalled(await installDeviceCli(device.id, runtime));
      await onRefresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("accounts.startFailed"),
      );
    } finally {
      setInstalling(undefined);
    }
  }
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
      {(["claude", "codex"] as const).map((runtime) => {
        const local = profiles.find(
          (profile) =>
            profile.origin === "device" &&
            profile.runtime === runtime &&
            profile.connectionType === "local_login",
        );
        const nativeHealth = health.find((row) => row.provider === runtime);
        const status = local?.status ?? nativeHealth?.status;
        const signedIn = !!local && status === "healthy";
        const unavailable = status === "unavailable";
        // i18n-ignore: runtime product names
        const name = runtime === "claude" ? "Claude Code" : "Codex";
        const cli = nativeHealth?.cli;
        const missing = cli?.installed === false;
        const online = device.status === "connected";
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
                    {signedIn
                      ? t("accounts.localLoginDetected")
                      : missing
                        ? t("accounts.cliMissing", { name })
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
                  : signedIn
                    ? t("accounts.localLogin")
                    : missing
                      ? t("accounts.notInstalled")
                      : unavailable
                        ? t("accounts.unavailable")
                        : t("accounts.workerNoLogin")}
              </Badge>
              {missing ? (
                <ConfirmButton
                  size="sm"
                  variant="secondary"
                  disabled={!online || installing !== undefined}
                  aria-label={t("accounts.installCliLabel", {
                    name,
                    device: device.label,
                  })}
                  confirmLabel={t("accounts.installCliConfirm", {
                    device: device.label,
                  })}
                  onConfirm={() => void installCli(runtime)}
                >
                  {installing === runtime
                    ? t("accounts.installingCli", {
                        name,
                        device: device.label,
                      })
                    : t("accounts.installCli", { name })}
                </ConfirmButton>
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
                  onClick={() => void checkLogin(runtime)}
                >
                  {checking === runtime
                    ? t("accounts.checking")
                    : t("accounts.checkAgain")}
                </Button>
              )}
            </div>
            {!signedIn && !missing && online ? (
              <p className="fdy-device-account-hint">
                {t(
                  runtime === "claude"
                    ? "accounts.signInHintClaude"
                    : "accounts.signInHintCodex",
                  { device: device.label },
                )}
              </p>
            ) : null}
            {missing && online ? (
              <p className="fdy-device-account-hint">
                {t("accounts.installCliHint", {
                  device: device.label,
                  command: cli?.installCommand,
                })}
              </p>
            ) : null}
            {installed?.runtime === runtime ? (
              <Alert
                tone={installed.ok ? "success" : "error"}
                title={t(
                  installed.ok
                    ? "accounts.installCliDone"
                    : "accounts.installCliFailed",
                  { name, device: device.label },
                )}
                details={
                  installed.log.trim() ? (
                    <pre className="fdy-device-account-log">
                      {installed.log}
                    </pre>
                  ) : undefined
                }
              >
                {installed.command}
              </Alert>
            ) : null}
            {cli?.outdated ? (
              <Alert
                tone="warning"
                title={t("accounts.cliOutdated", {
                  name,
                  device: device.label,
                  version: cli.version,
                  minimum: cli.minimumVersion,
                  command: cli.updateCommand,
                })}
              />
            ) : null}
            {expanded === runtime ? (
              <div className="fdy-account-expanded">
                <AccountInspection
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
      {error ? <p role="alert">{error}</p> : null}
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
