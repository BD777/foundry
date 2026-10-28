import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { StatusItem } from "../components/ui/status-indicator";
import { toast, type ToastTone } from "../components/ui/toast";
import { useNewBuildAvailable } from "./deployed-build";
import type { ApiState } from "./use-workspace-data";

/** Transient outcomes share the app's floating Toast viewport. */
export function useTransientNotice() {
  const notify = useCallback((message: string, tone?: ToastTone) => {
    if (message) toast({ title: message, tone });
  }, []);
  return ["", notify] as const;
}

/**
 * How long reads must keep failing before the app says the server cannot
 * be reached: a restart, a network blip or one slow read recovers sooner
 * (reads retry meanwhile, see useWorkspaceData).
 */
export const unreachableGraceMs = 8_000;

/** A load this quick shows nothing; a slower one says it is loading. */
export const loadingGraceMs = 1_500;

/** Whether `active` has held for `ms` without a break. */
export function useSustained(active: boolean, ms: number): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!active) {
      setHeld(false);
      return undefined;
    }
    const timer = setTimeout(() => setHeld(true), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);
  return active && held;
}

export interface AppStatusInput {
  apiState: ApiState;
  demoFallback: boolean;
  /** Reads again now, for "Retry now". */
  onRetry: () => void;
}

/**
 * The conditions of the whole app, for the sidebar's StatusIndicator: the
 * server cannot be reached (after unreachableGraceMs), a slow load, a newer
 * build deployed. Each holds until it clears; none takes room on the page.
 */
export function useAppStatus({
  apiState,
  demoFallback,
  onRetry,
}: AppStatusInput): StatusItem[] {
  const { t } = useTranslation("shell");
  const unreachable = useSustained(
    apiState === "fallback",
    demoFallback ? 0 : unreachableGraceMs,
  );
  const loading = useSustained(apiState === "loading", loadingGraceMs);
  const newBuild = useNewBuildAvailable();
  const items: StatusItem[] = [];
  if (unreachable)
    items.push(
      demoFallback
        ? {
            id: "demo",
            tone: "warning",
            label: t("status.demoLabel"),
            title: t("status.demoTitle"),
          }
        : {
            id: "unreachable",
            tone: "warning",
            label: t("status.unreachableLabel"),
            title: t("status.unreachableTitle"),
            description: t("status.unreachableDetail"),
            action: { label: t("status.retryNow"), onClick: onRetry },
          },
    );
  else if (loading)
    items.push({
      id: "loading",
      tone: "progress",
      label: t("status.loadingLabel"),
      title: t("status.loadingTitle"),
    });
  if (newBuild)
    items.push({
      id: "new-build",
      tone: "info",
      label: t("status.newVersionLabel"),
      title: t("notices.newVersion"),
      action: {
        label: t("notices.reloadNewVersion"),
        onClick: () => location.reload(),
      },
    });
  return items;
}
