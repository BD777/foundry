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
import {
  inspectDeviceAccount,
  resumeNativeAccount,
  signOutNativeAccount,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { HelpHint } from "../../components/ui/help-hint";
import { RowMenu } from "../../components/ui/row-menu";
import { runtimeMeta } from "../../components/agent-runtime/runtime-mark";
import { DeviceAccountDefaults } from "./device-account-defaults";
import { AccountInspection } from "./account-inspection";
import { ChevronDown, ChevronRight } from "lucide-react";
import { deviceReadiness, runtimeInstallKey } from "../../lib/device-readiness";
import { installRuntime, useRuntimeInstalls } from "../../lib/runtime-installs";
import {
  RuntimeActionButton,
  runtimeReadinessText,
} from "../../components/devices/runtime-readiness";
import { useSharedNow } from "../../lib/use-shared-now";

const accountLogClass =
  "m-0 max-h-60 overflow-auto text-2xs whitespace-pre-wrap";

export type NativeRuntime = "claude" | "codex";

/** The device's official login row for a runtime, when it reported one. */
export function localLoginRow(
  profiles: AgentProfileProjection[],
  deviceId: string,
  runtime: NativeRuntime,
): AgentProfileProjection | undefined {
  return profiles.find(
    (profile) =>
      profile.deviceId === deviceId &&
      profile.origin === "device" &&
      profile.runtime === runtime &&
      profile.connectionType === "local_login",
  );
}

/**
 * One device's official login for one runtime (a subscription), with what
 * its owner does about it here: sign in through the device's own CLI, check
 * the login again, install or update the CLI, resume a suspended account,
 * sign out, and, expanded, the account's usage and the device's defaults.
 */
export function RuntimeAccountRow({
  device,
  runtime,
  profiles,
  health,
  bindings,
  serverProfiles,
  onRefresh,
  onSignIn,
}: {
  device: DeviceProjection;
  runtime: NativeRuntime;
  /** Profile rows the device reported (any device; this one's are used). */
  profiles: AgentProfileProjection[];
  /** This device's runtime health. */
  health: ProviderHealth[];
  bindings: DeviceProfileBinding[];
  /** Server model providers, to tell which runtimes assigned ones need. */
  serverProfiles: ProfileDefinition[];
  onRefresh: () => Promise<void>;
  onSignIn: () => void;
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
  const ready = readiness.runtimes[runtime];
  const busy = ready.state === "installing" || ready.state === "updating";
  const now = useSharedNow(busy);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [resuming, setResuming] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const local = localLoginRow(profiles, device.id, runtime);
  const nativeHealth = health.find((row) => row.provider === runtime);
  const status = local?.status ?? nativeHealth?.status;
  const hold = local?.accountHold;
  const signedIn = !!local && status === "healthy";
  const unavailable = status === "unavailable";
  const name = runtimeMeta(runtime).productName;
  const cli = nativeHealth?.cli;
  const missing = cli?.installed === false;
  const online = device.status === "connected";
  const failed = ready.state === "install_failed";
  const attempt = installs.get(runtimeInstallKey(device.id, runtime));

  async function installCli(): Promise<void> {
    setError("");
    await installRuntime(device.id, runtime);
    await onRefresh().catch(() => {});
  }
  async function checkLogin(): Promise<void> {
    setChecking(true);
    setError("");
    try {
      await inspectDeviceAccount(device.id, runtime);
      await onRefresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("accounts.checkFailed"),
      );
    } finally {
      setChecking(false);
    }
  }
  async function signOut(): Promise<void> {
    setError("");
    try {
      await signOutNativeAccount(device.id, runtime);
      await onRefresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("accounts.signOutFailed"),
      );
    }
  }

  const summary = hold
    ? t("accounts.suspended")
    : signedIn
      ? local?.accountLabel
        ? t("accounts.signedInAs", { account: local.accountLabel })
        : t("accounts.localLoginDetected")
      : busy || failed || missing
        ? runtimeReadinessText(tDevices, ready, device.label, now)
        : unavailable
          ? (local?.statusDetail ??
            nativeHealth?.statusDetail ??
            t("accounts.installNative"))
          : t("accounts.noLogin");
  const badge = !online
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
              : t("accounts.workerNoLogin");

  return (
    <div className="grid gap-0 border-b border-line last:border-b-0">
      <div className="flex min-w-0 items-center gap-3 py-3 max-[700px]:flex-wrap max-[700px]:gap-2">
        <Button
          variant="ghost"
          className="-ml-2 h-auto flex-1 justify-start gap-3 rounded-lg border-0 p-2 text-left whitespace-normal active:scale-100 focus-visible:outline-0 focus-visible:shadow-[inset_0_0_0_1px_var(--fdy-control-focus)] max-[700px]:basis-[70%]"
          aria-expanded={expanded}
          aria-label={t("accounts.detailsLabel", {
            name,
            device: device.label,
          })}
          onClick={() => setExpanded(!expanded)}
        >
          <span className="grid min-w-0 flex-1 gap-1">
            <strong className="text-sm">{device.label}</strong>
            <small className="text-xs leading-[1.5] font-normal text-ink-muted">
              {summary}
            </small>
          </span>
          <span className="text-2xs font-normal text-ink-muted max-[1000px]:hidden">
            {t("accounts.accountAndDefaults")}
          </span>
          {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </Button>
        <Badge tone={signedIn && online ? "online" : "neutral"}>{badge}</Badge>
        {busy ? null : missing ? (
          <>
            <RuntimeActionButton
              device={device}
              readiness={readiness}
              row={ready}
            />
            {online ? (
              <HelpHint label={t("accounts.installCliHelpLabel", { name })}>
                {t("accounts.installCliHint", { device: device.label })}
              </HelpHint>
            ) : null}
          </>
        ) : (
          <>
            {!signedIn && !hold && !unavailable ? (
              <Button
                size="sm"
                variant="primary"
                disabled={!online}
                aria-label={t("accounts.signInLabel", {
                  name,
                  device: device.label,
                })}
                onClick={onSignIn}
              >
                {t("accounts.signIn")}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="secondary"
              disabled={!online || checking}
              aria-busy={checking}
              aria-label={t("accounts.checkAgainLabel", {
                name,
                device: device.label,
              })}
              busy={checking}
              onClick={() => void checkLogin()}
            >
              {checking ? t("accounts.checking") : t("accounts.checkAgain")}
            </Button>
          </>
        )}
        <RowMenu
          label={t("accounts.actions", { name, device: device.label })}
          disabled={!online}
          items={
            signedIn
              ? [
                  {
                    key: "sign-out",
                    label: t("accounts.signOut"),
                    tone: "danger",
                    confirm: {
                      title: t("accounts.signOutTitle", {
                        name,
                        device: device.label,
                      }),
                      body: t("accounts.signOutBody", {
                        name,
                        device: device.label,
                      }),
                      action: t("accounts.signOut"),
                    },
                    onSelect: () => void signOut(),
                  },
                ]
              : []
          }
        />
      </div>
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
                disabled={resuming}
                aria-busy={resuming}
                onClick={async () => {
                  setResuming(true);
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
                    setResuming(false);
                  }
                }}
              >
                {resuming ? t("accounts.resuming") : t("accounts.resume")}
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
          busy={busy}
          onUpdate={() => void installCli()}
        />
      ) : null}
      {error ? <ToastFeedback tone="error" title={error} /> : null}
      {expanded ? (
        <div className="grid grid-cols-2 gap-7 pt-2 pb-6 max-[1000px]:grid-cols-1">
          {cli?.installed ? (
            <AgentRuntimeStatus
              cli={cli}
              online={online}
              busy={busy}
              onCheck={() => void installCli()}
            />
          ) : null}
          <AccountInspection
            key={local?.runtimeGeneration ?? cli?.generation ?? runtime}
            identity={local?.runtimeGeneration ?? cli?.generation}
            deviceId={device.id}
            runtime={runtime}
            online={online}
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
}
