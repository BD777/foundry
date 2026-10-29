import type { DeviceProjection } from "@bd777/foundry-protocol";

/**
 * The commands that bring a device's worker back, typed on that machine as
 * its own account, with nothing left implicit: which service, which user,
 * where the logs are. Unit and log folder come from what the worker last
 * reported; a worker too old to report them gets the names Foundry installs
 * by default, marked as such (DEV-088).
 */
export interface RecoveryStep {
  key: "status" | "linger" | "restart" | "logs" | "memory" | "foreground";
  commands: string[];
}

export interface RecoveryPlan {
  platform: "linux" | "macos" | "other";
  /** The systemd unit or launchd label the steps name. */
  unit?: string;
  /** The unit is Foundry's default name, not one the worker reported. */
  unitAssumed: boolean;
  user?: string;
  steps: RecoveryStep[];
}

const defaultUnit = "foundry-worker.service";
const defaultLabel = "dev.foundry.worker";
const defaultLogDir = "~/.foundry/logs";

/** One-shot swap file for a small Linux machine (2 GiB). */
export const swapCommands = [
  "sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile",
  "sudo mkswap /swapfile && sudo swapon /swapfile",
  "echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab",
];

export function lingerCommand(user?: string): string {
  return `sudo loginctl enable-linger ${user || "$USER"}`;
}

function platformOf(device: Pick<DeviceProjection, "system">) {
  const os = device.system?.os ?? "";
  if (/mac/i.test(os) || /darwin/i.test(device.system?.kernel ?? ""))
    return "macos" as const;
  if (
    !os ||
    /linux|debian|ubuntu|fedora|centos|alpine|arch|rhel|suse/i.test(os)
  )
    return "linux" as const;
  return "other" as const;
}

export function recoveryPlan(
  device: Pick<DeviceProjection, "system" | "worker">,
  { lowMemory = false }: { lowMemory?: boolean } = {},
): RecoveryPlan {
  const platform = platformOf(device);
  const service = device.system?.service;
  const user = device.system?.user;
  const logDir = service?.logDir ?? defaultLogDir;
  const worker = device.worker?.command ?? "foundry-worker";
  if (platform === "linux") {
    const unit = service?.unit ?? defaultUnit;
    const steps: RecoveryStep[] = [
      { key: "status", commands: [`systemctl --user status ${unit}`] },
    ];
    if (service?.linger !== true)
      steps.push({ key: "linger", commands: [lingerCommand(user)] });
    steps.push(
      { key: "restart", commands: [`systemctl --user restart ${unit}`] },
      {
        key: "logs",
        commands: [
          `journalctl --user -u ${unit} -n 100 --no-pager`,
          `tail -n 50 ${logDir}/daemon.err.log`,
        ],
      },
    );
    if (lowMemory)
      steps.push({
        key: "memory",
        commands: [`journalctl --user -u ${unit} --since -7d | grep -i oom`],
      });
    return { platform, unit, unitAssumed: !service?.unit, user, steps };
  }
  if (platform === "macos") {
    const unit = service?.unit ?? defaultLabel;
    return {
      platform,
      unit,
      unitAssumed: !service?.unit,
      user,
      steps: [
        {
          key: "status",
          commands: [`launchctl print gui/$(id -u)/${unit} | head -20`],
        },
        {
          key: "restart",
          commands: [`launchctl kickstart -k gui/$(id -u)/${unit}`],
        },
        { key: "logs", commands: [`tail -n 50 ${logDir}/daemon.err.log`] },
      ],
    };
  }
  return {
    platform,
    unitAssumed: false,
    user,
    steps: [
      { key: "status", commands: [`${worker} status`] },
      { key: "foreground", commands: [`${worker} connect`] },
    ],
  };
}
