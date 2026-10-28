import { useEffect, useState } from "react";
import type { Issue } from "@bd777/foundry-protocol";
import { getIssue, isAbortError } from "../api";
import { navigateAppRoute } from "./navigation";

/**
 * An Issue page opened by id (a link, the address bar) whose Issue the
 * workspace shown does not hold. Its own workspace is looked up and the
 * page opens there, correcting the address in place: the link named the
 * Issue, not where. "opening" while that runs; "missing" when the Issue
 * cannot be read or is this workspace's after all.
 */
export function useLinkedIssue({
  issueId,
  issues,
  ready,
  workspaceId,
}: {
  issueId: string;
  issues: readonly Issue[];
  ready: boolean;
  workspaceId: string;
}): "listed" | "opening" | "missing" {
  const listed = !issueId || issues.some((issue) => issue.id === issueId);
  const key = `${workspaceId}\u0000${issueId}`;
  // The lookup that found the Issue elsewhere and opened its workspace, and
  // the one that ended here: neither is repeated until the Issue is shown.
  const [followed, setFollowed] = useState("");
  const [settled, setSettled] = useState("");
  const wanted = Boolean(!listed && ready && workspaceId);

  useEffect(() => {
    if (listed) {
      setFollowed("");
      setSettled("");
    }
  }, [listed]);

  useEffect(() => {
    if (!wanted || settled === key || followed === key) return;
    const controller = new AbortController();
    getIssue(issueId, { signal: controller.signal }).then(
      (issue) => {
        if (controller.signal.aborted) return;
        if (!issue.workspaceId || issue.workspaceId === workspaceId) {
          setSettled(key);
          return;
        }
        setFollowed(key);
        navigateAppRoute(
          { selectedIssueId: issueId, view: "issue" },
          issue.workspaceId,
          undefined,
          { replace: true },
        );
      },
      (error: unknown) => {
        if (!controller.signal.aborted && !isAbortError(error)) setSettled(key);
      },
    );
    return () => controller.abort();
  }, [followed, issueId, key, settled, wanted, workspaceId]);

  if (listed) return "listed";
  // A switch that failed leaves the workspace shown: the Issue is not here.
  if (settled === key || (followed === key && ready)) return "missing";
  return "opening";
}
