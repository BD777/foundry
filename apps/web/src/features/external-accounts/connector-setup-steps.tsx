import type {
  ConnectorDescriptor,
  ConnectorProgressPayload,
  DeviceConnectorDevice,
  DeviceConnectorState,
} from "@bd777/foundry-protocol";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import type { SetupChecklistState } from "../../components/ui/setup-checklist";
import { formatDuration } from "../../lib/format";
import { useSharedNow } from "../../lib/use-shared-now";
import {
  connectorInstallKey,
  installConnector,
  useConnectorInstalls,
  type ConnectorInstall,
} from "./connector-installs";
import { installNeed, installProgressText } from "./device-held-format";
import { ProgressMeter } from "../../components/ui/progress-meter";
import { connectorName } from "./connector-text";

export interface InstallStep {
  state: SetupChecklistState;
  copy: "running" | "failed" | "done" | "missing" | "outdated";
  title: string;
  detail?: ReactNode;
  /** The step's one action (Install, Update, Retry), or none while it runs. */
  action?: ReactNode;
}

/**
 * Where installing the connector's tool on the device stands: missing or
 * outdated with its Install action, running with the device's progress,
 * failed with the device's reason and Retry, or just done. Undefined when
 * there is nothing to install.
 */
export function useInstallStep(
  connector: ConnectorDescriptor,
  device: DeviceConnectorDevice,
  state: DeviceConnectorState | undefined,
  onState: (state: DeviceConnectorState) => void,
): InstallStep | undefined {
  const { t } = useTranslation("externalAccounts");
  const activity = useConnectorInstalls().get(
    connectorInstallKey(device.deviceId, connector.kind),
  );
  const now = useSharedNow(activity?.state === "running");
  const name = connectorName(connector);
  const values = { name, device: device.name };
  const step = installStepOf(activity, installNeed(connector, state));
  if (!step) return undefined;
  const blocked = !device.online ? t("setupSteps.offline", values) : undefined;
  const install = () =>
    void installConnector(device.deviceId, connector.kind).then((next) => {
      if (next) onState(next);
    });
  const detail =
    step.copy === "running" ? (
      <InstallProgressLine
        elapsed={t("setupSteps.install.elapsed", {
          ...values,
          elapsed: formatDuration(Math.max(0, now - activity!.startedAt)),
        })}
        label={t("setupSteps.progress.label", values)}
        progress={device.progress?.find(
          (entry) => entry.kind === connector.kind,
        )}
      />
    ) : step.copy === "failed" ? (
      [activity?.detail, blocked].filter(Boolean).join(" ")
    ) : step.copy === "done" ? (
      t(
        connector.tool.source === "npm"
          ? "setupSteps.install.doneDetail.npm"
          : "setupSteps.install.doneDetail.installer",
        values,
      )
    ) : (
      [
        t(
          connector.tool.source === "npm"
            ? "setupSteps.install.how.npm"
            : "setupSteps.install.how.installer",
          { ...values, package: connector.tool.package ?? "" },
        ),
        blocked,
      ]
        .filter(Boolean)
        .join(" ")
    );
  return {
    ...step,
    title: t(`setupSteps.install.${step.copy}`, {
      ...values,
      version: activity?.result?.version ?? state?.version ?? "",
      minimum: connector.tool.minimumVersion ?? "",
    }),
    detail,
    action:
      step.copy === "running" || step.copy === "done" ? undefined : (
        <Button
          aria-label={t(
            step.copy === "failed"
              ? "setupSteps.install.retryLabel"
              : step.copy === "outdated"
                ? "setupSteps.install.updateLabel"
                : "setupSteps.install.actionLabel",
            values,
          )}
          disabled={Boolean(blocked)}
          onClick={install}
          size="sm"
          variant="primary"
        >
          {step.copy === "failed"
            ? t("setupSteps.install.retry")
            : step.copy === "outdated"
              ? t("setupSteps.install.update", values)
              : t("setupSteps.install.action", values)}
        </Button>
      ),
  };
}

/**
 * A running install: a meter (indeterminate until the device reports a
 * download size) and its step in words. The meter is there from the start,
 * so nothing moves when the first report lands.
 */
function InstallProgressLine({
  progress,
  label,
  elapsed,
}: {
  progress?: ConnectorProgressPayload;
  label: string;
  elapsed: string;
}) {
  const { text, value, max } = installProgressText(progress);
  return (
    <span className="grid min-w-0 gap-1">
      <ProgressMeter
        aria-label={label}
        className="max-w-90"
        max={max}
        value={value}
      />
      <span>{[text, elapsed].join(" · ")}</span>
    </span>
  );
}

function installStepOf(
  activity: ConnectorInstall | undefined,
  need: ReturnType<typeof installNeed>,
):
  | {
      state: SetupChecklistState;
      copy: "running" | "failed" | "done" | "missing" | "outdated";
    }
  | undefined {
  if (activity?.state === "running")
    return { state: "running", copy: "running" };
  if (activity?.state === "failed") return { state: "failed", copy: "failed" };
  if (activity?.state === "succeeded" && activity.result?.installed)
    return { state: "done", copy: "done" };
  if (!need) return undefined;
  return { state: "needed", copy: need };
}
