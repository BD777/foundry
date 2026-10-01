import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  AgentProfileProjection,
  DeviceProjection,
  ProfileAuthorization,
  ProfileDefinition,
  DeviceProfileBinding,
  ProviderHealth,
} from "@bd777/foundry-protocol";
import {
  completeDeviceAuthorization,
  startDeviceAuthorization,
} from "../../api";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { AuthorizationFlow } from "../../components/ui/authorization-flow";
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
  const [authorization, setAuthorization] = useState<ProfileAuthorization>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pollAttempt, setPollAttempt] = useState(0);
  const [expanded, setExpanded] = useState<string>();
  async function complete(value?: string) {
    if (!authorization) return;
    const result = await completeDeviceAuthorization(
      device.id,
      authorization.runtime,
      authorization.id,
      value,
    );
    setAuthorization(result);
    if (result.status === "completed") await onRefresh();
  }
  useEffect(() => {
    if (
      busy ||
      authorization?.status !== "waiting_for_user" ||
      device.status !== "connected"
    )
      return;
    let canceled = false;
    const timer = window.setTimeout(() => {
      void completeDeviceAuthorization(
        device.id,
        authorization.runtime,
        authorization.id,
      )
        .then(async (result) => {
          if (canceled) return;
          setAuthorization(result);
          if (result.status === "completed") await onRefresh();
        })
        .catch((cause) => {
          if (!canceled) {
            setError(
              cause instanceof Error
                ? cause.message
                : t("accounts.checkFailed"),
            );
            setPollAttempt((attempt) => attempt + 1);
          }
        });
    }, 2000);
    return () => {
      canceled = true;
      window.clearTimeout(timer);
    };
  }, [authorization, busy, device.id, device.status, onRefresh, pollAttempt]);
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
        const active = authorization?.runtime === runtime;
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
                    : unavailable
                      ? t("accounts.unavailable")
                      : t("accounts.workerNoLogin")}
              </Badge>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy || device.status !== "connected" || unavailable}
                aria-label={t(
                  signedIn
                    ? "accounts.reauthorizeLabel"
                    : "accounts.signInLabel",
                  { name, device: device.label },
                )}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    const result = await startDeviceAuthorization(
                      device.id,
                      runtime,
                    );
                    setAuthorization(result);
                    if (result.status === "completed") await onRefresh();
                  } catch (cause) {
                    setError(
                      cause instanceof Error
                        ? cause.message
                        : t("accounts.startFailed"),
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {signedIn ? t("accounts.reauthorize") : t("accounts.signIn")}
              </Button>
            </div>
            {active && authorization ? (
              <AuthorizationFlow
                className="fdy-device-authorization-card"
                authorization={authorization}
                busy={busy}
                onComplete={(value) => {
                  setBusy(true);
                  setError("");
                  void complete(value)
                    .catch((cause) =>
                      setError(
                        cause instanceof Error
                          ? cause.message
                          : t("accounts.loginFailed"),
                      ),
                    )
                    .finally(() => setBusy(false));
                }}
              />
            ) : null}
            {expanded === runtime ? (
              <div className="fdy-account-expanded">
                <AccountInspection
                  deviceId={device.id}
                  runtime={runtime}
                  online={device.status === "connected"}
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
        </details>
      ) : null}
    </section>
  );
}
