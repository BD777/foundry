import type { Issue, Run, RunEvent } from "@bd777/foundry-protocol";
import type { FoundryData } from "../../api-types";
import {
  eachPayload,
  keepStreamed,
  type LoadedMerges,
  type StreamProjection,
  type StreamProjections,
} from "./stream-projection";

/** Issues a live event replaced. */
export const issueTouchKinds = ["issues"] as const;

export function mergeIssueRun(current: Run | undefined, incoming: Run): Run {
  if (!current || current.id !== incoming.id) return incoming;
  const terminal = (run: Run) =>
    ["completed", "failed", "canceled"].includes(run.status);
  const base = terminal(current) && !terminal(incoming) ? current : incoming;
  const events = [...incoming.events];
  const seen = new Set(events.map((event) => event.id));
  for (const event of current.events)
    if (!seen.has(event.id)) events.push(event);
  return { ...base, events };
}

export function mergeIssue(current: Issue | undefined, incoming: Issue): Issue {
  const terminal = (issue: Issue) =>
    issue.status === "accepted" || issue.status === "abandoned";
  if (current && terminal(current) && !terminal(incoming)) return current;
  if (!current?.run) return incoming;
  if (!incoming.run) return current;
  if (current.run.id !== incoming.run.id) {
    return (current.run.startedAt ?? "") > (incoming.run.startedAt ?? "")
      ? current
      : incoming;
  }
  const run = mergeIssueRun(current.run, incoming.run);
  // An older HTTP read must not revive an execution that has already finished.
  const base =
    incoming.run.status === "running" && run.status !== "running"
      ? current
      : incoming;
  const messages = [...(base.messages ?? [])];
  const seen = new Set(messages.map((message) => message.id));
  for (const message of current.messages ?? [])
    if (!seen.has(message.id)) messages.push(message);
  return { ...base, run, messages };
}

/** A whole Issue of the workspace shown, merged over the one shown. */
function applyIssue(data: FoundryData, incoming: Issue): FoundryData {
  if (incoming.workspaceId !== data.workspace.id) return data;
  const issue = mergeIssue(
    data.issues.find((item) => item.id === incoming.id),
    incoming,
  );
  return {
    ...data,
    issues: [issue, ...data.issues.filter((item) => item.id !== issue.id)],
    runs: issue.run
      ? [
          issue.run,
          ...(data.runs ?? []).filter((run) => run.id !== issue.run!.id),
        ]
      : data.runs,
  };
}

/** One event of an Issue's run, added to the run shown. */
function applyRunEvent(data: FoundryData, incoming: RunEvent): FoundryData {
  const issue = data.issues.find((item) => item.run?.id === incoming.runId);
  if (!issue?.run || issue.run.events.some((item) => item.id === incoming.id))
    return data;
  const run = { ...issue.run, events: [...issue.run.events, incoming] };
  return {
    ...data,
    issues: data.issues.map((item) =>
      item.id === issue.id ? { ...item, run } : item,
    ),
    runs: [run, ...(data.runs ?? []).filter((item) => item.id !== run.id)],
  };
}

const issueReplaced: StreamProjection<"issue_created" | "issue_updated"> = {
  apply: eachPayload(applyIssue),
  touches: (issue) => [["issues", issue.id]],
};

export const issueProjections = {
  issue_created: issueReplaced,
  issue_updated: issueReplaced,
  // Run events only add to a run; merging a read keeps what either side has,
  // so a read needs no note of them.
  issue_run_event: { apply: eachPayload(applyRunEvent) },
} satisfies StreamProjections;

export const issueLoadedMerges = {
  // An Issue an event replaced after the read started stays as shown; the
  // rest merge, so an older read never revives a finished execution.
  issues: (current, loaded, touched) =>
    keepStreamed(
      current.issues,
      loaded.issues.map((issue) =>
        mergeIssue(
          current.issues.find((item) => item.id === issue.id),
          issue,
        ),
      ),
      touched?.issues,
    ),
  runs: (current, loaded) =>
    loaded.runs?.map((run) =>
      mergeIssueRun(
        current.runs?.find((item) => item.id === run.id),
        run,
      ),
    ),
} satisfies LoadedMerges;
