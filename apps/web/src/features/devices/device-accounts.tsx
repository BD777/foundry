import { useEffect, useState } from "react";
import type {
  AgentProfileProjection,
  DeviceProjection,
  ProfileAuthorization,
  ProfileDefinition,
  DeviceProfileBinding,
  ProviderHealth,
} from "@foundry/protocol";
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
              cause instanceof Error ? cause.message : "Could not check login.",
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
                      ? "Local login detected · Online validity not checked"
                      : unavailable
                        ? (local?.statusDetail ??
                          nativeHealth?.statusDetail ??
                          "Install the native agent on this device.")
                        : "No login in the worker’s configuration · Check other local configurations"}
                  </small>
                </span>
                <span className="fdy-account-open-label">
                  Account & defaults
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
                  ? "Device offline"
                  : signedIn
                    ? "Local login"
                    : unavailable
                      ? "Unavailable"
                      : "Worker: no login"}
              </Badge>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy || device.status !== "connected" || unavailable}
                aria-label={`${signedIn ? "Re-authorize" : "Sign in to"} ${name} on ${device.label}`}
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
                        : "Could not start login on this device.",
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {signedIn ? "Re-authorize" : "Sign in"}
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
                          : "Login failed.",
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
            Earlier official profile settings ({legacy.length})
          </summary>
          <p>
            Preserved for existing sessions; these are runtime presets, not
            separate accounts. New logins use the device accounts above. No
            historical records have been changed.
          </p>
          {legacy.map((profile) => (
            <div key={profile.id} className="fdy-management-row">
              <span>
                <strong>{profile.label}</strong>
                <small>
                  {profile.runtime} · {profile.model || "Runtime default"} ·{" "}
                  {bindings.some(
                    (row) =>
                      row.deviceId === device.id &&
                      row.profileId === profile.id &&
                      row.enabled,
                  )
                    ? "Previously assigned to this device"
                    : "Not assigned to this device"}
                </small>
              </span>
            </div>
          ))}
        </details>
      ) : null}
    </section>
  );
}
