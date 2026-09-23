import { useEffect, useMemo, useState } from "react";
import type { Issue, Run } from "@foundry/protocol";
import { EmptyState } from "../../components/ui/empty-state";
import { PageSurface } from "../../components/ui/page-surface";
import {
  RunsFilterControl,
  RunsTable,
  RunsToolbar,
  type RunsTableRow,
} from "./runs-table";
import { issueDisplayId, issueSortValue } from "../../lib/issue-meta";
import {
  preferredRunId,
  runDisplayId,
  runDuration,
  runPhase,
  runSortValue,
  runStatusLabel,
} from "../../lib/run-meta";

type RunFilter = "all" | "running" | "completed" | "failed";

export type RunsFeatureEvent = {
  issueId: string;
  runId: string;
  type: "run.selected";
};

export interface RunsFeatureProps {
  focusRunId?: string;
  issues: Issue[];
  history?: Run[];
  onEvent?: (event: RunsFeatureEvent) => void;
}

/**
 * Owns all view-only run state. Consumers provide domain input and receive
 * semantic events; filter and row expansion never leak into the app shell.
 */
export function RunsFeature({
  focusRunId,
  issues,
  history,
  onEvent,
}: RunsFeatureProps) {
  const [filter, setFilter] = useState<RunFilter>("all");
  const [selectedRunId, setSelectedRunId] = useState(
    () => focusRunId ?? preferredRunId(issues),
  );
  const runs = useMemo(
    () =>
      [...issues]
        .sort((left, right) => issueSortValue(left) - issueSortValue(right))
        .flatMap((issue) =>
          (history ?? (issue.run ? [issue.run] : []))
            .filter((run) => run.issueId === issue.id)
            .map((run) => ({ issue, run })),
        )
        .sort(
          (left, right) => runSortValue(left.run) - runSortValue(right.run),
        ),
    [issues, history],
  );
  const effectiveSelectedRunId = runs.some(
    ({ run }) => run.id === selectedRunId,
  )
    ? selectedRunId
    : (focusRunId ?? runs[0]?.run.id ?? "");

  useEffect(() => {
    if (focusRunId) {
      setSelectedRunId(focusRunId);
    }
  }, [focusRunId]);

  const displayedRuns = runs.filter(
    ({ run }) => filter === "all" || run.status === filter,
  );
  const rows: RunsTableRow[] = displayedRuns.map(({ issue, run }) => {
    const selected = effectiveSelectedRunId === run.id;
    const statusTone: RunsTableRow["statusTone"] =
      run.status === "running"
        ? "brass"
        : run.status === "failed"
          ? "error"
          : "online";

    return {
      duration: runDuration(run),
      events: run.events.map((event, index) => ({
        active: index === run.events.length - 1 && run.status === "running",
        detail: event.detail,
        id: event.id,
        label: event.label,
        when: event.at,
      })),
      expanded: selected,
      id: runDisplayId(run.id),
      issueId: issueDisplayId(issue),
      issueTitle: issue.title,
      onSelect: () => {
        setSelectedRunId(run.id);
        onEvent?.({ issueId: issue.id, runId: run.id, type: "run.selected" });
      },
      phase: runPhase(run),
      running: run.status === "running",
      runtime: run.runtime,
      selected,
      status: run.status,
      statusLabel: runStatusLabel(run.status),
      statusTone,
    };
  });

  return (
    <PageSurface variant="runs">
      <RunsToolbar>
        <RunsFilterControl
          ariaLabel="Run status filter"
          onValueChange={setFilter}
          options={[
            { label: "All", value: "all" },
            { label: "Running", value: "running" },
            { label: "Succeeded", value: "completed" },
            { label: "Failed", value: "failed" },
          ]}
          value={filter}
        />
      </RunsToolbar>

      <RunsTable
        emptyState={
          <EmptyState
            title="No runs"
            body="Runs appear after a local worker claims an issue."
          />
        }
        rows={rows}
      />
    </PageSurface>
  );
}
