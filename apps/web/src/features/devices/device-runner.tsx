import type {
  DeviceProjection,
  DeviceRunner,
  DeviceRunnerTurn,
} from "@bd777/foundry-protocol";
import type { TFunction } from "i18next";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { readDeviceRunner, switchDeviceRunner } from "../../api";
import { i18n } from "../../i18n";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { Skeleton } from "../../components/ui/loading";

/** A runner that waits for, runs or failed its switch; absent when current. */
export function runnerSwitchState(
  device: DeviceProjection,
): Exclude<DeviceRunner["state"], "current"> | undefined {
  const state = device.runner?.state;
  return state && state !== "current" ? state : undefined;
}

const shortTime = (iso: string) =>
  new Date(iso).toLocaleTimeString(i18n.language, {
    hour: "2-digit",
    minute: "2-digit",
  });

/** The device list's badge for a runner that has not switched yet. */
export function RunnerStateBadge({ device }: { device: DeviceProjection }) {
  const { t } = useTranslation("devices");
  const state = runnerSwitchState(device);
  if (!state || !device.owned) return null;
  return (
    <Badge
      tone={state === "failed" || state === "unavailable" ? "warn" : "brass"}
    >
      {t(
        state === "switching"
          ? "worker.runner.badgeSwitching"
          : state === "failed"
            ? "worker.runner.badgeFailed"
            : state === "unavailable"
              ? "worker.runner.badgeUnavailable"
              : "worker.runner.badgePending",
      )}
    </Badge>
  );
}

/** The runner's state word for its row. */
export function runnerStateLabel(
  t: TFunction<"devices">,
  runner: DeviceRunner | undefined,
): string {
  switch (runner?.state) {
    case "pending":
      return t("worker.runner.pending");
    case "switching":
      return t("worker.runner.switching");
    case "failed":
      return t("worker.runner.failed");
    case "unavailable":
      return t("worker.runner.unavailable");
    default:
      return t("worker.stateCurrent");
  }
}

/** What a waiting runner waits for, and until when new turns wait for it. */
export function RunnerNote({ runner }: { runner: DeviceRunner }) {
  const { t } = useTranslation("devices");
  if (runner.state === "current" || runner.state === "switching") return null;
  const lines: string[] = [];
  const time = runner.deadline ? shortTime(runner.deadline) : "";
  if (runner.state === "unavailable")
    lines.push(
      t(
        runner.reclaiming
          ? "worker.runner.reclaiming"
          : "worker.runner.notAnswering",
      ),
    );
  else if (runner.state === "failed" && runner.error)
    lines.push(t("worker.runner.failedReason", { error: runner.error }));
  else if (runner.waitingFor === "background")
    lines.push(t("worker.runner.background"));
  else if (runner.waitingFor === "turns")
    lines.push(
      t("worker.runner.pastDeadline", { count: runner.runningTurns, time }),
    );
  else if (runner.runningTurns)
    lines.push(
      t("worker.runner.waitingUntil", { count: runner.runningTurns, time }),
    );
  if (runner.heldTurns)
    lines.push(t("worker.runner.held", { count: runner.heldTurns }));
  if (!lines.length) return null;
  return <p role="status">{lines.join(" ")}</p>;
}

/**
 * "Switch now": the owner reviews the turns it stops in a confirmation, and
 * only those are stopped; Cancel keeps waiting.
 */
export function SwitchRunnerNow({
  device,
  onRefresh,
}: {
  device: DeviceProjection;
  onRefresh?: () => Promise<void>;
}) {
  const { t } = useTranslation(["devices", "common"]);
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<DeviceRunnerTurn[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const cancelRef = useRef<HTMLButtonElement>(null);
  const load = async () => {
    setTurns(undefined);
    try {
      setTurns((await readDeviceRunner(device.id)).turns);
    } catch (cause) {
      setTurns([]);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  useEffect(() => {
    if (open) void load();
    // Read again on every opening: turns start and end.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const running = (turns ?? []).filter((turn) => !turn.background);
  const confirm = async () => {
    if (!turns) return;
    setBusy(true);
    setError("");
    try {
      await switchDeviceRunner(device.id, running);
      setOpen(false);
      await onRefresh?.().catch(() => {});
    } catch (cause) {
      setError(
        t("worker.runner.switchFailed", {
          error: cause instanceof Error ? cause.message : String(cause),
        }),
      );
      // Another turn may have started: show the list as it is now.
      await load();
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => {
          setError("");
          setOpen(true);
        }}
      >
        {t("worker.runner.switchNow")}
      </Button>
      <Dialog
        open={open}
        layout="compact"
        title={t("worker.runner.confirmTitle")}
        description={
          turns && !turns.length
            ? t("worker.runner.confirmNone")
            : t("worker.runner.confirmDescription")
        }
        onClose={() => setOpen(false)}
        busy={busy}
        initialFocus={cancelRef}
        footer={
          <>
            <Button
              ref={cancelRef}
              variant="secondary"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              {t("common:actions.cancel")}
            </Button>
            <Button
              variant="danger"
              disabled={busy || !turns}
              aria-busy={busy}
              onClick={() => void confirm()}
            >
              {busy
                ? t("worker.runner.switchingNow")
                : running.length
                  ? t("worker.runner.confirm", { count: running.length })
                  : t("worker.runner.confirmEmpty")}
            </Button>
          </>
        }
      >
        {!turns ? (
          <Skeleton
            label={t("worker.runner.loading")}
            rows={2}
            variant="rows"
          />
        ) : turns.length ? (
          <ul className="fdy-device-runner-turns">
            {turns.map((turn) => (
              <li key={`${turn.sessionId}/${turn.inputId ?? ""}`}>
                <span>
                  {turn.title ||
                    t("worker.runner.untitled", { id: turn.sessionId })}
                </span>
                {turn.background ? (
                  <Badge tone="neutral">
                    {t("worker.runner.backgroundOnly")}
                  </Badge>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {error ? <Alert tone="error" size="compact" title={error} /> : null}
      </Dialog>
    </>
  );
}
