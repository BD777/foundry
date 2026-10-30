import type {
  ConnectorDescriptor,
  ConnectorProgressPayload,
  DeviceConnectorDevice,
  DeviceConnectorState,
} from "@bd777/foundry-protocol";
import type { ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { CopyButton } from "../../components/ui/copy-button";
import {
  SetupChecklist,
  SetupChecklistItem,
  type SetupChecklistState,
} from "../../components/ui/setup-checklist";
import { TerminalBlock } from "../../components/ui/terminal-block";
import { formatDuration } from "../../lib/format";
import { useSharedNow } from "../../lib/use-shared-now";
import {
  connectorInstallKey,
  installConnector,
  useConnectorInstalls,
  type ConnectorInstall,
} from "./connector-installs";
import {
  installNeed,
  installProgressText,
  installable,
  localSignInCommands,
} from "./device-held-format";
import { ProgressMeter } from "../../components/ui/progress-meter";
import { AwsBrowserSignIn } from "./aws-browser-sign-in";

interface Step {
  key: string;
  state: SetupChecklistState;
  title: string;
  detail?: ReactNode;
  action?: ReactNode;
}

/**
 * What a device still needs before sessions there can use the connector,
 * inside the device's row: installing its tool (running, failed with the
 * device's reason and Retry, or done) and, for a tool signed in from the
 * terminal, the exact command to run there. Nothing when it is ready.
 */
export function ConnectorSetupSteps({
  connector,
  device,
  state,
  onState,
}: {
  connector: ConnectorDescriptor;
  device: DeviceConnectorDevice;
  state?: DeviceConnectorState;
  onState: (state: DeviceConnectorState) => void;
}) {
  const { t } = useTranslation("externalAccounts");
  const activity = useConnectorInstalls().get(
    connectorInstallKey(device.deviceId, connector.kind),
  );
  const now = useSharedNow(activity?.state === "running");
  const name = connector.label;
  const values = { name, device: device.name };
  const install = () =>
    void installConnector(device.deviceId, connector.kind).then((next) => {
      if (next) onState(next);
    });
  const steps: Step[] = [];
  const need = installNeed(connector, state);
  const blocked = !device.online
    ? t("setupSteps.offline", values)
    : !device.supported || !installable(connector, device)
      ? t("setupSteps.workerTooOld", values)
      : undefined;
  const installStep = installStepOf(activity, need);
  if (installStep)
    steps.push({
      key: "install",
      ...installStep,
      title: t(`setupSteps.install.${installStep.copy}`, {
        ...values,
        version: activity?.result?.version ?? state?.version ?? "",
        minimum: connector.tool.minimumVersion ?? "",
      }),
      detail:
        installStep.copy === "running" ? (
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
        ) : installStep.copy === "failed" ? (
          [activity?.detail, blocked].filter(Boolean).join(" ")
        ) : installStep.copy === "done" ? (
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
                : "setupSteps.install.how.aws",
              {
                ...values,
                package: connector.tool.package ?? "",
              },
            ),
            blocked,
          ]
            .filter(Boolean)
            .join(" ")
        ),
      action:
        installStep.copy === "running" ||
        installStep.copy === "done" ? undefined : (
          <Button
            aria-label={t(
              installStep.copy === "failed"
                ? "setupSteps.install.retryLabel"
                : "setupSteps.install.actionLabel",
              values,
            )}
            disabled={Boolean(blocked)}
            onClick={install}
            size="sm"
            variant="primary"
          >
            {installStep.copy === "failed"
              ? t("setupSteps.install.retry")
              : t("setupSteps.install.action", values)}
          </Button>
        ),
    });
  const commands = localSignInCommands(connector, activity?.result ?? state);
  const current = activity?.result ?? state;
  // Browser sign-in when the device's worker drives it; the terminal is
  // the last resort, folded away.
  const browser =
    Boolean(connector.browserSignIn?.length) &&
    // An offline device reports no capabilities; keep the browser sign-in
    // as the way in and say why it waits, rather than fall back to a shell.
    (!device.online || Boolean(device.browserSignInSupported));
  const terminal = commands ? (
    <>
      <span className="fdy-xacc-command">
        <TerminalBlock
          lines={[{ id: "sso", prompt: "$", value: commands.primary }]}
        />
        <CopyButton
          copiedLabel={t("setupSteps.signIn.copied")}
          label={t("setupSteps.signIn.copy", { command: commands.primary })}
          text={commands.primary}
        />
      </span>
      <span>
        <Trans
          components={{ code: <code /> }}
          i18nKey="setupSteps.signIn.others"
          ns="externalAccounts"
          values={{ keys: commands.keys, renew: commands.renew }}
        />
      </span>
    </>
  ) : null;
  if (
    commands &&
    connector.authentication === "local" &&
    current?.installed &&
    !current.signedIn &&
    activity?.state !== "running" &&
    (current.status === "signed_out" || current.status === "expired")
  )
    steps.push({
      key: "sign-in",
      state: "needed",
      title: browser
        ? t("setupSteps.signIn.browserTitle", values)
        : t("setupSteps.signIn.title", values),
      detail: browser ? (
        <>
          <AwsBrowserSignIn
            connector={connector}
            device={device}
            onState={onState}
          />
          <details className="fdy-xacc-terminal-fallback">
            <summary>{t("setupSteps.signIn.terminalFallback", values)}</summary>
            {terminal}
          </details>
        </>
      ) : (
        terminal
      ),
    });
  if (steps.length === 0) return null;
  return (
    <SetupChecklist
      className="fdy-xacc-setup"
      label={t("setupSteps.label", values)}
      surface="none"
    >
      {steps.map(({ key, ...step }) => (
        <SetupChecklistItem key={key} {...step} />
      ))}
    </SetupChecklist>
  );
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
    <span className="fdy-xacc-progress">
      <ProgressMeter aria-label={label} max={max} value={value} />
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
