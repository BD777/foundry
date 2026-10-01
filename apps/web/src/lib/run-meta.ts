import type { Issue, Run } from "@bd777/foundry-protocol";
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

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return i18n.t("runs:duration.minutes", {
      minutes,
      seconds: seconds.toString().padStart(2, "0"),
    });
  }
  return i18n.t("runs:duration.seconds", { seconds });
}

export function runDuration(run: Run): string {
  const started = run.startedAt ? Date.parse(run.startedAt) : NaN;
  if (Number.isNaN(started)) {
    return "";
  }
  const ended = run.completedAt
    ? Date.parse(run.completedAt)
    : run.status === "running"
      ? Date.now()
      : NaN;
  if (Number.isNaN(ended) || ended <= started) {
    return "";
  }
  return formatDuration(ended - started);
}

export function runStatusLabel(status: Run["status"]): string {
  return i18n.t(`runs:status.${status}`);
}

export function runDisplayId(id: string): string {
  return id.replace(/^run_/i, "RUN-");
}

export function runSortValue(run: Run): number {
  const order: Record<Run["status"], number> = {
    blocked: 0,
    running: 1,
    queued: 2,
    completed: 3,
    failed: 4,
    canceled: 5,
  };

  return order[run.status];
}

export function preferredRunId(issues: Issue[]): string {
  return (
    issues.find((issue) => issue.run?.status === "running")?.run?.id ??
    issues.find((issue) => issue.run)?.run?.id ??
    ""
  );
}

export function candidateWorktreeLabel(): string {
  return "worktree";
}
