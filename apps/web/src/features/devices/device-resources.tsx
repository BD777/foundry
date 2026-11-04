import { ToastFeedback } from "../../components/ui/toast";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { ArrowRight, RefreshCw } from "lucide-react";
import {
  macWorkerBackend,
  type DeviceProjection,
  type ResourceInstance,
} from "@bd777/foundry-protocol";
import { refreshDeviceResources } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { navigateToResources } from "../../lib/in-app-navigation";
import {
  useResourceInventory,
  type ResourceInventory,
} from "../../lib/resource-inventory";
import { HelpHint } from "../../components/ui/help-hint";
import { SectionHeader } from "../../components/ui/page-header";
import { DeviceSection } from "./device-section";

/**
 * One line on what the resource inventory lists for the device ("5
 * resources · 1 not ready") and the way to the Resources page filtered to it.
 */
function DeviceResourceSummary({
  device,
  inventory: { list, error, loading },
  instances,
}: {
  device: DeviceProjection;
  inventory: ResourceInventory;
  instances: ResourceInstance[];
}) {
  const { t } = useTranslation("devices");
  const unready = instances.filter(
    (instance) => instance.state === "unready",
  ).length;
  const stale = instances.filter((instance) => instance.stale).length;
  const source = list?.sources.find((item) => item.id === device.id);
  const summary = list
    ? [
        t("resources.summary.count", { count: instances.length }),
        unready ? t("resources.summary.unready", { count: unready }) : "",
        stale ? t("resources.summary.stale", { count: stale }) : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : t(
        error && !loading
          ? "resources.summary.failed"
          : "resources.summary.loading",
      );
  return (
    <div
      aria-label={t("resources.summary.label", { device: device.label })}
      className="fdy-device-resource-summary flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-line-soft py-2 text-sm text-ink-muted [&>span]:min-w-0 [&>span]:wrap-anywhere"
      role="group"
    >
      <span role="status">{summary}</span>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => navigateToResources(device.id)}
      >
        {t("resources.summary.open")}
        <ArrowRight aria-hidden="true" size={14} />
      </Button>
      {source ? (
        <span className="fdy-device-resource-remote flex basis-full flex-wrap items-center gap-1">
          <span>
            {t(
              source.allowRemoteCommands
                ? "resources.summary.remoteOn"
                : "resources.summary.remoteOff",
            )}
          </span>
          {device.owned ? <span aria-hidden="true">·</span> : null}
          {device.owned ? (
            <Button
              aria-label={t("resources.summary.manageRemoteLabel", {
                device: device.label,
              })}
              size="sm"
              variant="ghost"
              onClick={() => navigateToResources(device.id, "compute")}
            >
              {t("resources.summary.manageRemote")}
              <ArrowRight aria-hidden="true" size={14} />
            </Button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The Resource Pool directory for one device: what its worker found that
 * sessions may use. Foundry lists the device's own software and installs
 * nothing. The device's owner can have it detect again, and while the
 * worker's own macOS screen control lacks the person's permission, have the
 * device show its permission prompts and open the right System Settings pane.
 */
export function DeviceResources({
  device,
  onRefresh,
}: {
  device: DeviceProjection;
  onRefresh: () => Promise<void>;
}) {
  const inventory = useResourceInventory({ device: device.id });
  const instances = (inventory.list?.instances ?? []).filter(
    (instance) => instance.source.id === device.id,
  );
  const screenControl = instances.find(
    (instance) =>
      !instance.readiness.ready &&
      instance.backends.some((backend) => backend.id === macWorkerBackend),
  );
  const manageable = Boolean(device.owned) && device.status === "connected";
  const { t } = useTranslation("devices");
  const [busy, setBusy] = useState<"detect" | "access" | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const refresh = async (requestAccess?: string) => {
    setBusy(requestAccess ? "access" : "detect");
    setMessage("");
    setError("");
    try {
      const result = await refreshDeviceResources(device.id, requestAccess);
      await onRefresh();
      inventory.reload();
      setMessage(
        !requestAccess
          ? t("resources.detected")
          : result.opened.length
            ? t("resources.settingsOpen", {
                device: device.label,
                panes: result.opened.join(", "),
              })
            : t("resources.promptsShown", { device: device.label }),
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("resources.unreachable"),
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <DeviceSection aria-labelledby="fdy-device-resources-heading">
      <SectionHeader
        title={t("resources.title")}
        titleId="fdy-device-resources-heading"
        description={t("resources.intro", { device: device.label })}
        help={
          <HelpHint label={t("resources.introHelpLabel")}>
            {t("resources.introHelp")}
          </HelpHint>
        }
        actions={
          manageable ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy !== null}
              onClick={() => void refresh()}
            >
              <RefreshCw
                className={busy === "detect" ? "animate-spin-slow" : undefined}
                size={14}
              />
              {busy === "detect"
                ? t("resources.detecting")
                : t("resources.detectAgain")}
            </Button>
          ) : null
        }
      />
      <DeviceResourceSummary
        device={device}
        inventory={inventory}
        instances={instances}
      />
      {screenControl && manageable ? (
        <Alert
          tone="warning"
          title={t("resources.screenAccessTitle")}
          actions={
            <Button
              size="sm"
              variant="primary"
              disabled={busy !== null}
              onClick={() => void refresh(macWorkerBackend)}
            >
              {busy === "access"
                ? t("resources.asking")
                : t("resources.openSettings")}
            </Button>
          }
        >
          <Trans
            ns="devices"
            i18nKey={
              screenControl.details?.grantTo
                ? "resources.screenAccessGrantTo"
                : "resources.screenAccess"
            }
            values={{
              device: device.label,
              grantTo: screenControl.details?.grantTo,
            }}
            components={{ code: <code /> }}
          />
        </Alert>
      ) : null}
      {message ? <ToastFeedback tone="success" title={message} /> : null}
      {error ? <ToastFeedback tone="error" title={error} /> : null}
    </DeviceSection>
  );
}
