import type { Issue } from "@bd777/foundry-protocol";
import type { FoundryData } from "../../api-types";
import { isIssueClosed } from "../../lib/issue-meta";
import {
  eachPayload,
  keepStreamed,
  type LoadedMerges,
  type StreamProjection,
  type StreamProjections,
} from "./stream-projection";

/** Issues a live event replaced. */
export const issueTouchKinds = ["issues"] as const;

export function mergeIssue(current: Issue | undefined, incoming: Issue): Issue {
  if (current && isIssueClosed(current) && !isIssueClosed(incoming))
    return current;
  if (!current?.run) return incoming;
  if (!incoming.run) return current;
  if (current.run.id !== incoming.run.id) {
    return (current.run.startedAt ?? "") > (incoming.run.startedAt ?? "")
      ? current
      : incoming;
  }
  // An older HTTP read must not revive an execution that has already finished.
  const base =
    incoming.run.status === "running" && current.run.status !== "running"
      ? current
      : incoming;
  const messages = [...(base.messages ?? [])];
  const seen = new Set(messages.map((message) => message.id));
  for (const message of current.messages ?? [])
    if (!seen.has(message.id)) messages.push(message);
  return { ...base, messages };
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
  };
}

const issueReplaced: StreamProjection<"issue_created" | "issue_updated"> = {
  apply: eachPayload(applyIssue),
  touches: (issue) => [["issues", issue.id]],
};

export const issueProjections = {
  issue_created: issueReplaced,
  issue_updated: issueReplaced,
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
} satisfies LoadedMerges;
