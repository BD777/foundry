import type { DeviceProjection } from "@bd777/foundry-protocol";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Alert } from "../ui/alert";
import { Button } from "../ui/button";
import { TerminalBlock } from "../ui/terminal-block";
import {
  disconnectCause,
  memoryLabel,
  offlineSince,
  type DeviceReadiness,
} from "../../lib/device-readiness";
import {
  lingerCommand,
  recoveryPlan,
  swapCommands,
} from "../../lib/device-recovery";
import { clockTime, fullWhen, relativeWhen } from "../../lib/time-format";
import { useCopied } from "../../lib/use-copied";

/** A titled block of commands with a labelled Copy button. */
export function CommandBlock({
  title,
  commands,
}: {
  title: string;
  commands: string[];
}) {
  const { t } = useTranslation("devices");
  const { copied, copy } = useCopied(1500);
  const text = commands.join("\n");
  return (
    <div className="fdy-command-block">
      <div className="fdy-command-block-head">
        <strong>{title}</strong>
        <Button
          aria-label={t("recovery.copyLabel", { step: title })}
          onClick={() => void copy(text)}
          size="sm"
          variant="secondary"
        >
          {copied() ? t("recovery.copied") : t("recovery.copy")}
        </Button>
      </div>
      <TerminalBlock
        lines={commands.map((command, index) => ({
          id: String(index),
          prompt: "$",
          value: command,
        }))}
      />
    </div>
  );
}

/** "Oct 29, 18:01" plus "3 hours ago", for when a device went offline. */
export function offlineSinceText(
  t: TFunction<"devices">,
  since: string | undefined,
): string {
  if (!since) return t("recovery.offline");
  return t("recovery.offlineSince", {
    time: clockTime(since, { date: "short" }),
    relative: relativeWhen(since),
  });
}

/**
 * An offline device: since when, why in plain words, and for its owner the
 * commands that bring it back on that machine.
 */
export function DeviceOfflineNotice({
  device,
  readiness,
}: {
  device: DeviceProjection;
  readiness: DeviceReadiness;
}) {
  const { t } = useTranslation("devices");
  const since = offlineSince(device);
  const cause = disconnectCause(device);
  const plan = recoveryPlan(device, { lowMemory: readiness.lowMemory });
  return (
    <section className="fdy-device-recovery" aria-labelledby="device-recovery">
      <Alert tone="warning" title={offlineSinceText(t, since)}>
        <p title={since ? fullWhen(since) : undefined}>
          {t(`recovery.cause.${cause ?? "unknown"}`)}
        </p>
      </Alert>
      {device.owned === false ? (
        <p>{t("recovery.sharedOwner", { device: device.label })}</p>
      ) : (
        <>
          <h3 id="device-recovery">{t("recovery.bringBack")}</h3>
          <p>
            {plan.user
              ? t("recovery.intro", { device: device.label, user: plan.user })
              : t("recovery.introNoUser", { device: device.label })}
          </p>
          <ol className="fdy-device-recovery-steps">
            {plan.steps.map((step) => (
              <li key={step.key}>
                <CommandBlock
                  commands={step.commands}
                  title={t(`recovery.steps.${step.key}`)}
                />
              </li>
            ))}
          </ol>
          {plan.unitAssumed && plan.unit ? (
            <p className="fdy-device-recovery-note">
              {t("recovery.unitAssumed", { unit: plan.unit })}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

/**
 * Hidden rules made visible while the device is online: a service that
 * stops at logout, processes stopped for lack of memory, no swap on a small
 * machine. Each with the command that fixes it.
 */
export function DeviceHealthNotices({
  device,
  readiness,
}: {
  device: DeviceProjection;
  readiness: DeviceReadiness;
}) {
  const { t } = useTranslation("devices");
  if (device.owned === false) return null;
  const user = device.system?.user;
  const memory = readiness.memoryBytes
    ? memoryLabel(readiness.memoryBytes)
    : "";
  const oom = readiness.oomKills;
  return (
    <>
      {readiness.keepsRunning === "no" ? (
        <Alert
          tone="warning"
          title={t("recovery.keepRunning.noTitle", { user: user ?? "" })}
        >
          <p>
            {t("recovery.keepRunning.noAlert", {
              user: user ?? "",
              device: device.label,
            })}
          </p>
          <CommandBlock
            commands={[lingerCommand(user)]}
            title={t("recovery.steps.linger")}
          />
        </Alert>
      ) : null}
      {oom ? (
        <Alert tone="warning" title={t("recovery.oom.title")}>
          <p>
            {t("recovery.oom.detail", {
              count: oom.count,
              device: device.label,
            })}{" "}
            {oom.lastAt
              ? t("recovery.oom.last", {
                  time: clockTime(oom.lastAt, { date: "short" }),
                })
              : null}
          </p>
        </Alert>
      ) : null}
      {readiness.lowMemory && readiness.noSwap ? (
        <Alert tone="warning" title={t("recovery.swap.title")}>
          <p>{t("recovery.swap.intro", { device: device.label, memory })}</p>
          <CommandBlock
            commands={swapCommands}
            title={t("recovery.swap.title")}
          />
        </Alert>
      ) : null}
    </>
  );
}
