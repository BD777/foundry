import type { Issue } from "@bd777/foundry-protocol";
import { Badge } from "../../components/ui/badge";
import { blockedReasonMeta, statusMeta } from "../../lib/issue-meta";

/** The list view's status cell: the state, and why when blocked. */
export function IssueListStatus({ issue }: { issue: Issue }) {
  const status = statusMeta(issue.status);
  const blocked = blockedReasonMeta(issue);
  return (
    <span title={blocked?.message}>
      <Badge className="fdy-issue-list-status" tone={status.tone}>
        {status.label}
      </Badge>
      {blocked ? <small> · {blocked.label}</small> : null}
    </span>
  );
}
