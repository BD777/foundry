import type { Issue, Run } from "@foundry/protocol";
import type { FoundryData, FoundryStreamEvent } from "../api-types";

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

export function applyIssueStreamEvent(
  current: FoundryData,
  event: Extract<
    FoundryStreamEvent,
    { type: "issue_updated" | "issue_run_event" }
  >,
): FoundryData {
  if (event.type === "issue_updated") {
    const incoming = event.payload;
    if (incoming.workspaceId !== current.workspace.id) return current;
    const issue = mergeIssue(
      current.issues.find((item) => item.id === incoming.id),
      incoming,
    );
    return {
      ...current,
      issues: [issue, ...current.issues.filter((item) => item.id !== issue.id)],
      runs: issue.run
        ? [
            issue.run,
            ...(current.runs ?? []).filter((run) => run.id !== issue.run!.id),
          ]
        : current.runs,
    };
  }
  const incoming = event.payload;
  const issue = current.issues.find((item) => item.run?.id === incoming.runId);
  if (!issue?.run || issue.run.events.some((item) => item.id === incoming.id))
    return current;
  const run = { ...issue.run, events: [...issue.run.events, incoming] };
  return {
    ...current,
    issues: current.issues.map((item) =>
      item.id === issue.id ? { ...item, run } : item,
    ),
    runs: [run, ...(current.runs ?? []).filter((item) => item.id !== run.id)],
  };
}
