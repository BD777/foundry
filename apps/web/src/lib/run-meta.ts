import type { Run } from "@bd777/foundry-protocol";
import { i18n } from "../i18n";

export function runPhase(run: Run): string {
  if (run.status === "running") {
    // Runtime identity does not tell us whether the agent is editing or testing.
    return i18n.t("runs:phase.executing");
  }
  if (run.status === "completed") {
    return i18n.t("runs:phase.complete");
  }
  if (run.status === "failed") {
    return i18n.t("runs:phase.failed");
  }
  if (run.status === "queued") {
    return i18n.t("runs:phase.queued");
  }
  return i18n.t("runs:phase.canceled");
}

export function runStatusLabel(status: Run["status"]): string {
  return i18n.t(`runs:status.${status}`);
}
