import type { DeviceProjection } from "@bd777/foundry-protocol";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { RuntimeMark, runtimeMeta } from "../ui/runtime-mark";
import {
  SetupChecklist,
  SetupChecklistItem,
  type SetupChecklistState,
} from "../ui/setup-checklist";
import {
  agentRuntimes,
  assignmentNote,
  memoryLabel,
  runtimeAction,
  type AgentRuntime,
  type DeviceReadiness,
  type RuntimeReadiness,
} from "../../lib/device-readiness";
import { installRuntime } from "../../lib/runtime-installs";
import { lingerCommand } from "../../lib/device-recovery";
import { CommandBlock } from "./device-recovery";
import { formatDuration } from "../../lib/format";
import { useSharedNow } from "../../lib/use-shared-now";

/** Whether this page may act on the runtime now. */
function actionable(readiness: DeviceReadiness): boolean {
  return readiness.online && readiness.owned;
}

/**
 * One sentence for where a runtime stands on a device. `now` makes running
 * installs show their elapsed time.
 */
export function runtimeReadinessText(
  t: TFunction<"devices">,
  row: RuntimeReadiness,
  device: string,
  now: number,
): string {
  const elapsed = row.startedAt
    ? formatDuration(Math.max(0, now - row.startedAt))
    : "";
  const values = {
    device,
    elapsed,
    version: row.version ?? "",
    target: row.target ?? "",
    count: row.assigned,
  };
  switch (row.state) {
    case "unknown":
      return t("readiness.runtime.unknown", values);
    case "missing":
      return row.assigned
        ? t("readiness.runtime.missingAssigned", values)
        : t("readiness.runtime.missing", values);
    case "installing":
      return t("readiness.runtime.installing", values).trim();
    case "install_failed":
      return t("readiness.runtime.installFailed", values);
    case "outdated":
      return t("readiness.runtime.outdated", values);
    case "updating":
      return t("readiness.runtime.updating", values).trim();
    case "external_update":
      return t("readiness.runtime.externalUpdate", values);
    case "ready": {
      const installed = row.version
        ? t(
            row.managed
              ? "readiness.runtime.readyManaged"
              : "readiness.runtime.readyExternal",
            values,
          )
        : t("readiness.runtime.ready");
      return row.signedIn
        ? installed
        : `${installed} ${t("readiness.runtime.notSignedIn")}`;
    }
  }
}

/** Why the action is not offered here, if it would be elsewhere. */
export function runtimeBlockedText(
  t: TFunction<"devices">,
  readiness: DeviceReadiness,
  row: RuntimeReadiness,
  device: string,
): string | undefined {
  if (!runtimeAction(row)) return undefined;
  if (!readiness.owned) return t("readiness.runtime.notOwner", { device });
  if (!readiness.online) return t("readiness.runtime.offline", { device });
  return undefined;
}

function checklistState(row: RuntimeReadiness): SetupChecklistState {
  switch (row.state) {
    case "ready":
      return "done";
    case "installing":
    case "updating":
      return "running";
    case "install_failed":
      return "failed";
    case "unknown":
      return "info";
    default:
      return "needed";
  }
}

/** The runtime's one action as a button, or nothing. */
export function RuntimeActionButton({
  device,
  readiness,
  row,
  variant = "secondary",
}: {
  device: Pick<DeviceProjection, "id" | "label">;
  readiness: DeviceReadiness;
  row: RuntimeReadiness;
  variant?: "primary" | "secondary";
}) {
  const { t } = useTranslation("devices");
  const action = runtimeAction(row);
  if (!action || !actionable(readiness)) return null;
  const name = runtimeMeta(row.runtime).productName;
  const copy = {
    install: ["readiness.actions.install", "readiness.actions.installLabel"],
    retry: ["readiness.actions.retry", "readiness.actions.retryLabel"],
    update: ["readiness.actions.update", "readiness.actions.updateLabel"],
    switch: ["readiness.actions.switch", "readiness.actions.switchLabel"],
  } as const;
  const [label, ariaLabel] = copy[action];
  return (
    <Button
      aria-label={t(ariaLabel, { name, device: device.label })}
      onClick={() => void installRuntime(device.id, row.runtime)}
      size="sm"
      variant={variant}
    >
      {t(label)}
    </Button>
  );
}

/** Runtimes "Install both" would install: the missing ones. */
function missingRuntimes(readiness: DeviceReadiness): AgentRuntime[] {
  return agentRuntimes.filter(
    (runtime) => readiness.runtimes[runtime].state === "missing",
  );
}

/** Installs every missing runtime on the device, as one explicit action. */
export function InstallAllButton({
  device,
  readiness,
}: {
  device: Pick<DeviceProjection, "id" | "label">;
  readiness: DeviceReadiness;
}) {
  const { t } = useTranslation("devices");
  const missing = missingRuntimes(readiness);
  if (missing.length < 2 || !actionable(readiness)) return null;
  return (
    <div className="fdy-device-readiness-actions">
      <Button
        aria-label={t("readiness.actions.installBothLabel", {
          device: device.label,
        })}
        onClick={() => {
          for (const runtime of missing)
            void installRuntime(device.id, runtime);
        }}
        size="sm"
        variant="primary"
      >
        {t("readiness.actions.installBoth")}
      </Button>
    </div>
  );
}

/**
 * A device's readiness to run agents: its worker, each runtime and its
 * memory, each with its state in words and at most one action.
 */
export function DeviceReadinessChecklist({
  device,
  readiness,
  showWorker = true,
}: {
  device: Pick<DeviceProjection, "id" | "label">;
  readiness: DeviceReadiness;
  showWorker?: boolean;
}) {
  const { t } = useTranslation("devices");
  const rows = agentRuntimes.map((runtime) => readiness.runtimes[runtime]);
  const now = useSharedNow(
    rows.some((row) => row.state === "installing" || row.state === "updating"),
  );
  return (
    <SetupChecklist
      label={t("readiness.checklistLabel", { device: device.label })}
    >
      {showWorker ? (
        <SetupChecklistItem
          detail={
            readiness.online
              ? t("readiness.worker.online")
              : t("readiness.worker.offline", { device: device.label })
          }
          state={readiness.online ? "done" : "needed"}
          title={t("readiness.worker.title")}
        />
      ) : null}
      {rows.map((row) => {
        const blocked = runtimeBlockedText(t, readiness, row, device.label);
        const text = runtimeReadinessText(t, row, device.label, now);
        return (
          <SetupChecklistItem
            action={
              <RuntimeActionButton
                device={device}
                readiness={readiness}
                row={row}
              />
            }
            detail={
              [text, row.detail, blocked].filter(Boolean).join(" ") || text
            }
            key={row.runtime}
            log={row.log}
            logLabel={t("readiness.log")}
            prefix={<RuntimeMark runtime={row.runtime} size="sm" />}
            state={checklistState(row)}
            title={runtimeMeta(row.runtime).productName}
          />
        );
      })}
      {readiness.keepsRunning !== "unknown" ? (
        <SetupChecklistItem
          detail={
            readiness.keepsRunning === "yes" ? (
              t("recovery.keepRunning.yes")
            ) : (
              <>
                {t("recovery.keepRunning.no", {
                  user: readiness.user ?? "",
                  device: device.label,
                })}
                <CommandBlock
                  commands={[lingerCommand(readiness.user)]}
                  title={t("recovery.steps.linger")}
                />
              </>
            )
          }
          state={readiness.keepsRunning === "yes" ? "done" : "needed"}
          title={t("recovery.keepRunning.title")}
        />
      ) : null}
      {readiness.oomKills ? (
        <SetupChecklistItem
          detail={t("recovery.oom.detail", {
            count: readiness.oomKills.count,
            device: device.label,
          })}
          state="info"
          title={t("recovery.oom.title")}
        />
      ) : null}
      {readiness.lowMemory && readiness.memoryBytes ? (
        <SetupChecklistItem
          detail={t("readiness.memory.low", {
            device: device.label,
            memory: memoryLabel(readiness.memoryBytes),
          })}
          state="info"
          title={t("readiness.memory.title")}
        />
      ) : null}
    </SetupChecklist>
  );
}

/**
 * One line on whether a runtime is there for a model provider on a device:
 * before it is assigned, what assigning will do about it; once assigned (or
 * while installing), where the runtime stands. Nothing when it is ready.
 */
export function RuntimeStateNote({
  device,
  readiness,
  runtime,
  assigned,
}: {
  device: Pick<DeviceProjection, "id" | "label">;
  readiness: DeviceReadiness;
  runtime: AgentRuntime;
  assigned: boolean;
}) {
  const { t } = useTranslation("devices");
  const row = readiness.runtimes[runtime];
  const live = row.state === "installing" || row.state === "updating";
  const now = useSharedNow(live);
  const name = runtimeMeta(runtime).productName;
  if (row.state === "ready" || row.state === "unknown") return null;
  let text: string;
  if (assigned || live) {
    const blocked = runtimeBlockedText(t, readiness, row, device.label);
    text = [
      `${name}: ${runtimeReadinessText(t, row, device.label, now)}`,
      row.state === "install_failed" ? row.detail : undefined,
      blocked,
    ]
      .filter(Boolean)
      .join(" ");
  } else {
    const note = assignmentNote(readiness, runtime);
    if (!note) return null;
    text = t(`readiness.assign.${note}`, { name, device: device.label });
  }
  return (
    <small
      className="fdy-runtime-state-note"
      data-state={row.state}
      role={live ? "status" : undefined}
    >
      {text}
    </small>
  );
}

/**
 * A device's readiness as a section: an optional intro, "Install both" when
 * both runtimes are missing, then the checklist.
 */
export function DeviceReadinessPanel({
  device,
  readiness,
  intro,
}: {
  device: Pick<DeviceProjection, "id" | "label">;
  readiness: DeviceReadiness;
  intro?: string;
}) {
  return (
    <div className="fdy-device-readiness">
      {intro ? <p className="fdy-device-readiness-intro">{intro}</p> : null}
      <InstallAllButton device={device} readiness={readiness} />
      <DeviceReadinessChecklist device={device} readiness={readiness} />
    </div>
  );
}
