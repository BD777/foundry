import type { DeviceProjection, WorkerRelease } from "@bd777/foundry-protocol";
import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { updateDeviceWorker } from "../../api";
import { i18n } from "../../i18n";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { TerminalBlock } from "../../components/ui/terminal-block";
import { useWorkerRelease } from "../../lib/worker-commands";

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
): "current" | "updating" | "updatable" | "manual" {
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
  const targets = devices.filter(
    (device) => workerState(device, release) === "updatable",
  );
  // Only the owner can update a device's worker; shared devices are theirs.
  const manual = devices.filter(
    (device) => device.owned && workerState(device, release) === "manual",
  );
  const running = devices.some((device) => device.workerUpdate);
  // Updating devices restart and reconnect; reload until each reports back.
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(
      () => void onRefresh().catch(() => {}),
      5000,
    );
    return () => window.clearInterval(timer);
  }, [running, onRefresh]);
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
  return { targets, manual, running, starting, result, startAll };
}

export type UpdateAllWorkersState = ReturnType<typeof useUpdateAllWorkers>;

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
  ].filter(Boolean);
  if (!notes.length && !state.result?.failures.length) return null;
  return (
    <div className="fdy-device-update-all">
      {notes.length ? <p role="status">{notes.join(" ")}</p> : null}
      {state.result?.failures.map((failure) => (
        <p className="fdy-location-error" role="alert" key={failure}>
          {failure}
        </p>
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
  const { release, update } = useWorkerRelease();
  const [copied, setCopied] = useState(false);
  const [updating, setUpdating] = useState<"starting" | "started">();
  const [updateError, setUpdateError] = useState("");
  const behind = workerBehind(device, release);
  // The server records an update until the device comes back with it, so
  // every page and every visit sees it running.
  const running = device.workerUpdate;
  // A worker that declares it can update itself does so on request; it
  // restarts and reconnects, so poll until the new version reports in.
  const selfUpdating = canSelfUpdate(device);
  useEffect(() => {
    if ((updating !== "started" && !running) || !onRefresh) return;
    if (!behind) {
      setUpdating(undefined);
      return;
    }
    const timer = window.setInterval(
      () => void onRefresh().catch(() => {}),
      5000,
    );
    const stop = window.setTimeout(() => {
      setUpdating(undefined);
      setUpdateError(t("worker.updateSlow"));
    }, 180000);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(stop);
    };
  }, [updating, running, behind, onRefresh, t]);
  if (prominent && !behind && !updating && !running) return null;
  // A worker set up with `install` has its own command; any other one is
  // switched once through npx.
  const command = device.worker?.command
    ? `${device.worker.command} update`
    : device.worker
      ? undefined
      : update;
  const versions = (
    <p>
      {t("worker.running", {
        version: device.worker?.version ?? t("worker.unknownVersion"),
      })}
      {release?.source === "server"
        ? ` ${t("worker.serverBuild", { version: release.version })}`
        : ` ${t("worker.serverNpm")}`}
    </p>
  );
  const startUpdate = async () => {
    setUpdating("starting");
    setUpdateError("");
    try {
      await updateDeviceWorker(device.id);
      setUpdating("started");
    } catch (cause) {
      setUpdating(undefined);
      setUpdateError(
        cause instanceof Error ? cause.message : t("worker.updateFailed"),
      );
    }
  };
  const body = (
    <>
      {versions}
      {running ||
      (selfUpdating && (behind || !release || release.source !== "server")) ? (
        <div className="fdy-device-worker-actions">
          <Button
            size="sm"
            variant="primary"
            disabled={!!updating || !!running}
            aria-busy={!!updating || !!running}
            onClick={() => void startUpdate()}
          >
            {updating || running ? t("worker.updating") : t("worker.updateNow")}
          </Button>
          {updating === "started" || running ? (
            <span role="status">
              {running
                ? t("worker.updateRunningSince", {
                    time: new Date(running.startedAt).toLocaleTimeString(
                      i18n.language,
                      { hour: "2-digit", minute: "2-digit" },
                    ),
                  })
                : t("worker.updateStarted")}
            </span>
          ) : null}
        </div>
      ) : null}
      {updateError ? (
        <p className="fdy-location-error" role="alert">
          {updateError}
        </p>
      ) : null}
      {selfUpdating ? null : command ? (
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
            <Button
              size="sm"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(command);
                  setCopied(true);
                } catch {
                  setCopied(false);
                }
              }}
            >
              {copied ? t("common:actions.copied") : t("add.copyCommand")}
            </Button>
          </div>
        </>
      ) : device.worker ? (
        <p>{t("worker.sourceCheckout")}</p>
      ) : null}
    </>
  );
  return prominent ? (
    <Alert
      className="fdy-device-worker"
      tone="warning"
      title={t("worker.behindTitle")}
    >
      {body}
    </Alert>
  ) : (
    <section className="fdy-device-section fdy-device-worker">
      <h2>{t("worker.title")}</h2>
      {body}
    </section>
  );
}
