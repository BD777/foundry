import type { Issue } from "@bd777/foundry-protocol";
import { Badge } from "../../components/ui/badge";
import { Tooltip } from "../../components/ui/tooltip";
import { cn } from "../../lib/cn";
import { blockedReasonMeta, statusMeta } from "../../lib/issue-meta";

/** The list view's status cell: the state, and why when blocked. */
export function IssueListStatus({
  compact = false,
  issue,
}: {
  /** Fixed and narrower, as the stacked cards show it. */
  compact?: boolean;
  issue: Issue;
}) {
  const status = statusMeta(issue.status);
  const blocked = blockedReasonMeta(issue);
  const cell = (
    <span>
      <Badge
        className={cn(
          "justify-start",
          compact ? "max-w-[104px] min-w-[104px]" : "min-w-[118px]",
        )}
        tone={status.tone}
      >
        {status.label}
      </Badge>
      {blocked ? <small> · {blocked.label}</small> : null}
    </span>
  );
  return blocked?.message ? (
    <Tooltip content={blocked.message} variant="hint">
      {cell}
    </Tooltip>
  ) : (
    cell
  );
}
