import type {
  DeviceProjection,
  DeviceWorkerUpdate,
  WorkerRelease,
} from "@bd777/foundry-protocol";
import type { TFunction } from "i18next";
import { useEffect, useState } from "react";
import { ArrowRight, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { updateDeviceWorker } from "../../api";
import { i18n } from "../../i18n";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { HelpHint } from "../../components/ui/help-hint";
import { InfoRow } from "../../components/ui/info-row";
import { TerminalBlock } from "../../components/ui/terminal-block";
import { useCopied } from "../../lib/use-copied";
import { useWorkerRelease } from "../../lib/worker-commands";
import {
  RunnerNote,
  SwitchRunnerNow,
  runnerStateLabel,
  runnerStateTone,
  runnerSwitchState,
} from "./device-runner";
import { Spinner } from "../../components/ui/loading";

/**
 * Whether a device's worker is behind the version this server serves. Only a
 * server serving its own build names a version; a worker older than 0.5.7
 * reports none and counts as behind it.
 */
export function workerBehind(
  device: DeviceProjection,
  release: WorkerRelease | undefined,
): boolean {
  return (
    release?.source === "server" && device.worker?.version !== release.version
  );
}

/**
 * Whether this page can ask the device's worker to update itself: it declares
 * the capability, was set up with `install`, and is connected.
 */
export function canSelfUpdate(device: DeviceProjection): boolean {
  return (
    Boolean(device.capabilities?.includes("worker_update")) &&
    Boolean(device.worker?.command) &&
    device.status === "connected"
  );
}

/**
 * The worker states the device list shows and Update all acts on. A device
 * already on the served version is "current" and is left alone.
 */
export function workerState(
  device: DeviceProjection,
  release: WorkerRelease | undefined,
): "current" | "updating" | "failed" | "stalled" | "updatable" | "manual" {
  if (device.workerUpdate?.failure) return "failed";
  if (device.workerUpdate?.stalled)
    return device.owned && canSelfUpdate(device) ? "stalled" : "manual";
  if (device.workerUpdate) return "updating";
  if (!workerBehind(device, release)) return "current";
  return device.owned && canSelfUpdate(device) ? "updatable" : "manual";
}

/**
 * Update all: starts the update on every device that is behind and can update
 * itself. Devices already current, already updating, offline or needing a
 * manual command are skipped; each failure is reported by device.
 */
export function useUpdateAllWorkers(
  devices: DeviceProjection[],
  release: WorkerRelease | undefined,
  onRefresh: () => Promise<void>,
) {
  const { t } = useTranslation("devices");
  const [starting, setStarting] = useState(false);
  const [result, setResult] = useState<{
    started: number;
    failures: string[];
  }>();
  // A stalled or failed update is started again with the rest.
  const targets = devices.filter((device) => {
    const state = workerState(device, release);
    return (
      state === "updatable" ||
      state === "stalled" ||
      (state === "failed" && device.owned && canSelfUpdate(device))
    );
  });
  // Only the owner can update a device's worker; shared devices are theirs.
  const manual = devices.filter(
    (device) => device.owned && workerState(device, release) === "manual",
  );
  const running = devices.some(
    (device) => workerState(device, release) === "updating",
  );
  // Their connection service is current; the runner follows on its own.
  const runners = devices.filter(
    (device) =>
      device.owned &&
      runnerSwitchState(device) &&
      runnerSwitchState(device) !== "unavailable",
  );
  const startAll = async () => {
    setStarting(true);
    setResult(undefined);
    const outcomes = await Promise.all(
      targets.map(async (device) => {
        try {
          await updateDeviceWorker(device.id);
          return undefined;
        } catch (cause) {
          return t("worker.updateAllFailure", {
            device: device.label,
            error:
              cause instanceof Error ? cause.message : t("worker.updateFailed"),
          });
        }
      }),
    );
    const failures = outcomes.filter(
      (failure): failure is string => failure !== undefined,
    );
    setResult({ started: targets.length - failures.length, failures });
    setStarting(false);
    await onRefresh().catch(() => {});
  };
  return { targets, manual, running, runners, starting, result, startAll };
}

export type UpdateAllWorkersState = ReturnType<typeof useUpdateAllWorkers>;

/** An update's step, e.g. "Downloading 0.5.8"; the caller says whether it runs. */
export function workerUpdateStepLabel(
  t: TFunction<"devices">,
  update: DeviceWorkerUpdate,
): string | undefined {
  switch (update.step) {
    case "starting":
      return t("worker.steps.starting");
    case "checking":
      return t("worker.steps.checking");
    case "downloading":
      return update.version
        ? t("worker.steps.downloadingVersion", { version: update.version })
        : t("worker.steps.downloading");
    case "installing":
      return update.version
        ? t("worker.steps.installingVersion", { version: update.version })
        : t("worker.steps.installing");
    case "restarting":
      return t("worker.steps.restarting");
    case "waiting":
      return t("worker.steps.waiting");
    default:
      return undefined;
  }
}

/** Why an update failed, in the reader's language where Foundry knows it. */
function workerUpdateFailure(
  t: TFunction<"devices">,
  update: DeviceWorkerUpdate,
): string {
  if (update.failureCode === "vanished") return t("worker.failedVanished");
  if (update.failureCode === "not_back") return t("worker.failedNotBack");
  return update.failure ?? "";
}

/** The header action; absent when no device can be updated from here. */
export function UpdateAllWorkersButton({
  state,
}: {
  state: UpdateAllWorkersState;
}) {
  const { t } = useTranslation("devices");
  if (!state.targets.length && !state.starting) return null;
  return (
    <Button
      variant="secondary"
      disabled={state.starting}
      aria-busy={state.starting}
      onClick={() => void state.startAll()}
    >
      <RefreshCw size={15} />
      {state.starting
        ? t("worker.updating")
        : t("worker.updateAll", { count: state.targets.length })}
    </Button>
  );
}

/** What Update all did, what is still running and what it cannot reach. */
export function UpdateAllWorkersStatus({
  state,
}: {
  state: UpdateAllWorkersState;
}) {
  const { t } = useTranslation("devices");
  const notes = [
    state.result?.started
      ? t("worker.updateAllStarted", { count: state.result.started })
      : state.running
        ? t("worker.updateAllRunning")
        : undefined,
    state.manual.length
      ? t("worker.updateAllManual", {
          devices: state.manual.map((device) => device.label).join(", "),
        })
      : undefined,
    state.runners.length
      ? t("worker.updateAllRunners", {
          devices: state.runners.map((device) => device.label).join(", "),
        })
      : undefined,
  ].filter(Boolean);
  if (!notes.length && !state.result?.failures.length) return null;
  return (
    <div className="fdy-device-update-all">
      {notes.length ? <p role="status">{notes.join(" ")}</p> : null}
      {state.result?.failures.map((failure) => (
        <Alert tone="error" size="compact" key={failure} title={failure} />
      ))}
    </div>
  );
}

/**
 * The device's worker: the version it runs, the version this server serves,
 * and the command that updates it on that machine. Prominent when behind.
 */
export function DeviceWorker({
  device,
  prominent,
  onRefresh,
}: {
  device: DeviceProjection;
  prominent?: boolean;
  /** Reloads devices, to see the worker come back with its new version. */
  onRefresh?: () => Promise<void>;
}) {
  const { t } = useTranslation(["devices", "common"]);
  const { t: tDevices } = useTranslation("devices");
  const { release, update, error: releaseError } = useWorkerRelease();
  const { copied, copy } = useCopied();
  const [updating, setUpdating] = useState<"starting" | "started">();
  const [updateError, setUpdateError] = useState("");
  const behind = workerBehind(device, release);
  // The server records an update until the device comes back with it, so
  // every page and every visit sees it running, failed or stalled.
  const failed = device.workerUpdate?.failure ? device.workerUpdate : undefined;
  const stalled =
    !failed && device.workerUpdate?.stalled ? device.workerUpdate : undefined;
  const running = failed || stalled ? undefined : device.workerUpdate;
  // A worker that declares it can update itself does so on request; it
  // restarts and reconnects. Each step and the new version reporting in
  // reach the page as device changes; past a few minutes it is slow.
  const selfUpdating = canSelfUpdate(device);
  useEffect(() => {
    if ((updating !== "started" && !running) || !onRefresh) return;
    if (!behind || failed) {
      setUpdating(undefined);
      return;
    }
    const stop = window.setTimeout(() => {
      setUpdating(undefined);
      setUpdateError(t("worker.updateSlow"));
    }, 180000);
    return () => window.clearTimeout(stop);
  }, [updating, running, failed, behind, onRefresh, t]);
  if (
    prominent &&
    !behind &&
    !updating &&
    !running &&
    !runnerSwitchState(device)
  )
    return null;
  const shortTime = (iso: string) =>
    new Date(iso).toLocaleTimeString(i18n.language, {
      hour: "2-digit",
      minute: "2-digit",
    });
  const runningStep = running && workerUpdateStepLabel(tDevices, running);
  const failedStep = failed && workerUpdateStepLabel(tDevices, failed);
  // A worker set up with `install` has its own command; any other one is
  // switched once through npx.
  const command = device.worker?.command
    ? `${device.worker.command} update`
    : device.worker
      ? undefined
      : update;
  const runner = device.runner;
  const updatingNow = Boolean(running || updating);
  // How the two parts relate, behind the "?" of the banner and the section.
  const help = (
    <HelpHint label={t("worker.helpLabel")}>
      <p>{t("worker.helpConnection")}</p>
      <p>{t("worker.helpRunner")}</p>
      <p>{t("worker.helpSwitchNow")}</p>
    </HelpHint>
  );
  // The banner names the one version change it waits for; Settings → Worker
  // lists both parts. The connection service talks to the server and
  // restarts at once on an update; the session runner follows when its
  // turns end.
  const change =
    behind || updatingNow
      ? {
          label: t("worker.title"),
          from: device.worker?.version,
          to: release?.source === "server" ? release.version : undefined,
        }
      : runner && runner.state !== "current"
        ? {
            label: t("worker.sessionRunner"),
            from: runner.version,
            to: runner.targetVersion ?? device.worker?.version,
          }
        : undefined;
  const versions = prominent ? (
    <>
      {change ? (
        <p className="fdy-device-worker-change">
          <span>{change.label}</span>
          <code>{change.from ?? t("worker.unknownVersion")}</code>
          {change.to ? (
            <>
              <ArrowRight
                size={13}
                role="img"
                aria-label={t("worker.changeTo")}
              />
              <code>{change.to}</code>
            </>
          ) : null}
        </p>
      ) : null}
      {runner && !behind ? <RunnerNote runner={runner} /> : null}
    </>
  ) : (
    <>
      <div className="fdy-device-worker-parts">
        <InfoRow
          density="compact"
          variant="keyValue"
          label={t("worker.connectionService")}
          meta={device.worker?.version ?? t("worker.unknownVersion")}
        >
          <Badge tone={updatingNow ? "slate" : behind ? "brass" : "online"}>
            {updatingNow
              ? t("worker.updating")
              : behind
                ? t("worker.stateUpdatable")
                : t("worker.stateCurrent")}
          </Badge>
        </InfoRow>
        {runner ? (
          <InfoRow
            density="compact"
            variant="keyValue"
            label={t("worker.sessionRunner")}
            meta={runner.version ?? t("worker.unknownVersion")}
          >
            <Badge tone={runnerStateTone(runner)}>
              {runnerStateLabel(tDevices, runner)}
            </Badge>
          </InfoRow>
        ) : null}
      </div>
      <p>
        {release?.source === "server"
          ? t("worker.serverBuild", { version: release.version })
          : release
            ? t("worker.serverNpm")
            : releaseError
              ? t("worker.serverUnknown")
              : t("worker.serverLoading")}
      </p>
      {runner ? <RunnerNote runner={runner} /> : null}
    </>
  );
  // Both the banner and Settings → Worker offer it: the owner should not
  // have to look for the way out of a wait. A banner about a Worker behind
  // the server leads with Update instead.
  const switchNow =
    device.owned &&
    device.status === "connected" &&
    !updatingNow &&
    !(prominent && behind) &&
    (runner?.state === "pending" || runner?.state === "failed") ? (
      <SwitchRunnerNow device={device} onRefresh={onRefresh} />
    ) : null;
  const startUpdate = async () => {
    setUpdating("starting");
    setUpdateError("");
    try {
      await updateDeviceWorker(device.id);
      // The server has replaced a failed update with this one; reload so the
      // old failure does not end it here.
      await onRefresh?.().catch(() => {});
      setUpdating("started");
    } catch (cause) {
      setUpdating(undefined);
      setUpdateError(
        cause instanceof Error ? cause.message : t("worker.updateFailed"),
      );
    }
  };
  const showFailure = !updating && (failed || stalled);
  const updateButton = (
    <Button
      size="sm"
      variant="primary"
      disabled={!!updating || !!running}
      aria-busy={!!updating || !!running}
      onClick={() => void startUpdate()}
    >
      {updating || running
        ? t("worker.updating")
        : stalled || failed
          ? t("worker.updateAgain")
          : t("worker.updateWorker")}
    </Button>
  );
  // Until this page knows which version the server serves it does not offer
  // a new update: a device already on it would only restart its connection
  // service. A failed or stalled one can always be retried, and an
  // npm-served release names no version, so it stays offered.
  const canStart =
    running ||
    (selfUpdating &&
      (behind || failed || stalled || release?.source === "npm"));
  // A failed or stalled update is an error of its own, apart from the warning
  // that the worker is behind; it carries what went wrong and the retry.
  const failure = !showFailure ? null : stalled ? (
    <Alert
      className="fdy-device-worker-failure"
      tone="error"
      title={t("worker.updateStalledTitle")}
    >
      <div className="fdy-device-worker-failure-body">
        <p>
          {t(stalled.log ? "worker.updateStalledLog" : "worker.updateStalled", {
            time: shortTime(stalled.startedAt),
            log: stalled.log,
          })}
        </p>
        {canStart ? (
          <div className="fdy-device-worker-actions">{updateButton}</div>
        ) : null}
      </div>
    </Alert>
  ) : failed ? (
    <Alert
      className="fdy-device-worker-failure"
      tone="error"
      title={t("worker.updateFailedTitle")}
    >
      <div className="fdy-device-worker-failure-body">
        <p>
          {t("worker.updateFailedReason", {
            reason: workerUpdateFailure(tDevices, failed),
          })}
        </p>
        {failedStep || failed.exitCode !== undefined ? (
          <p>
            {[
              failedStep
                ? t("worker.updateLastStep", { step: failedStep })
                : undefined,
              failed.exitCode !== undefined
                ? t("worker.updateExitCode", { code: failed.exitCode })
                : undefined,
            ]
              .filter(Boolean)
              .join(" ")}
          </p>
        ) : null}
        {failed.logTail?.length ? (
          <details className="fdy-device-worker-log">
            <summary>
              {t(
                failed.log ? "worker.updateLogTailAt" : "worker.updateLogTail",
                {
                  log: failed.log,
                },
              )}
            </summary>
            <TerminalBlock
              className="fdy-device-worker-log-lines"
              lines={failed.logTail.map((line, index) => ({
                id: String(index),
                value: line,
              }))}
            />
          </details>
        ) : null}
        {canStart ? (
          <div className="fdy-device-worker-actions">{updateButton}</div>
        ) : null}
      </div>
    </Alert>
  ) : null;
  const body = (
    <>
      {versions}
      {prominent ? null : failure}
      {canStart && !showFailure ? (
        <div className="fdy-device-worker-actions">
          {updateButton}
          {switchNow}
          {updating === "started" || running ? (
            <span role="status">
              <Spinner />{" "}
              {running
                ? runningStep
                  ? t("worker.updateStepSince", {
                      step: runningStep,
                      time: shortTime(running.startedAt),
                    })
                  : t("worker.updateRunningSince", {
                      time: shortTime(running.startedAt),
                    })
                : t("worker.updateStarted")}
            </span>
          ) : null}
        </div>
      ) : null}
      {switchNow && !(canStart && !showFailure) ? (
        <div className="fdy-device-worker-actions">{switchNow}</div>
      ) : null}
      {running?.stepDetail ? (
        <p>{t("worker.updateWaiting", { detail: running.stepDetail })}</p>
      ) : null}
      {updateError ? (
        <Alert tone="error" size="compact" title={updateError} />
      ) : null}
      {selfUpdating || (prominent && !behind) ? null : command ? (
        <>
          <p>
            {t(device.worker?.command ? "worker.runLocal" : "worker.runOnce", {
              device: device.label,
            })}
          </p>
          <TerminalBlock
            lines={[{ id: "update", prompt: "$", value: command }]}
          />
          <div className="fdy-device-worker-actions">
            <Button size="sm" onClick={() => void copy(command)}>
              {copied() ? t("common:actions.copied") : t("add.copyCommand")}
            </Button>
          </div>
        </>
      ) : device.worker ? (
        <p>{t("worker.sourceCheckout")}</p>
      ) : null}
    </>
  );
  return prominent ? (
    <>
      <Alert
        className="fdy-device-worker"
        tone="warning"
        title={
          <span className="fdy-device-worker-title">
            {behind || updatingNow
              ? t("worker.behindTitle")
              : t("worker.runnerTitle")}
            {help}
          </span>
        }
      >
        <div className="fdy-device-worker-body">{body}</div>
      </Alert>
      {failure}
    </>
  ) : (
    <section className="fdy-device-section fdy-device-worker">
      <h2 className="fdy-device-worker-title">
        {t("worker.title")}
        {help}
      </h2>
      {body}
    </section>
  );
}
