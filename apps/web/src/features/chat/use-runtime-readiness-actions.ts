import { createElement, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type {
  AgentProjection,
  DeviceProjection,
  ProviderHealth,
} from "@bd777/foundry-protocol";
import type { SelectMenuAction } from "../../components/ui/select-menu";
import { RuntimeMark, runtimeMeta } from "../../components/ui/runtime-mark";
import { agentRuntimes, deviceReadiness } from "../../lib/device-readiness";
import { installRuntime, useRuntimeInstalls } from "../../lib/runtime-installs";
import { formatDuration } from "../../lib/format";
import { useSharedNow } from "../../lib/use-shared-now";

/**
 * Picker rows for agents that cannot run because their runtime (Claude Code
 * or Codex) is missing on the workspace's device: one row per runtime, whose
 * one action installs it there (DEV-088). Only the device's owner gets them.
 */
export function useRuntimeReadinessActions({
  agents,
  device,
  providerHealth,
}: {
  agents: readonly AgentProjection[];
  device?: DeviceProjection;
  providerHealth: readonly ProviderHealth[];
}): SelectMenuAction[] {
  const { t } = useTranslation("devices");
  const installs = useRuntimeInstalls();
  const readiness = useMemo(
    () =>
      device
        ? deviceReadiness({
            device,
            providerHealth: [...providerHealth],
            installs,
          })
        : undefined,
    [device, providerHealth, installs],
  );
  const live = Boolean(
    readiness &&
    agentRuntimes.some(
      (runtime) => readiness.runtimes[runtime].state === "installing",
    ),
  );
  const now = useSharedNow(live);
  if (!device || !readiness || !readiness.owned) return [];
  return agentRuntimes.flatMap((runtime): SelectMenuAction[] => {
    const row = readiness.runtimes[runtime];
    const count = agents.filter(
      (agent) => agent.deviceId === device.id && agent.provider === runtime,
    ).length;
    if (
      !count ||
      !["missing", "installing", "install_failed"].includes(row.state)
    )
      return [];
    const name = runtimeMeta(runtime).productName;
    const values = { name, device: device.label, count };
    const prefix = createElement(RuntimeMark, { runtime, size: "sm" });
    if (row.state === "installing")
      return [
        {
          key: `install-${runtime}`,
          label: t("readiness.picker.installing", values),
          detail: row.startedAt
            ? formatDuration(Math.max(0, now - row.startedAt))
            : undefined,
          prefix,
          busy: true,
          onSelect: () => {},
        },
      ];
    const failed = row.state === "install_failed";
    return [
      {
        key: `install-${runtime}`,
        label: t(
          failed ? "readiness.picker.failed" : "readiness.picker.install",
          values,
        ),
        detail: !readiness.online
          ? t("readiness.runtime.offline", values)
          : failed
            ? (row.detail ?? t("readiness.runtime.installFailed", values))
            : t("readiness.picker.detail", values),
        actionLabel: failed
          ? t("readiness.actions.retry")
          : t("readiness.picker.action"),
        prefix,
        disabled: !readiness.online,
        onSelect: () => void installRuntime(device.id, runtime),
      },
    ];
  });
}
