import type { Issue } from "@bd777/foundry-protocol";
import { workerPackageName } from "@bd777/foundry-protocol";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import {
  blockedReasonMeta,
  issueDisplayStatus,
  statusMeta,
} from "../../lib/issue-meta";

/** An older worker clarifies and verifies but cannot execute Issues. */
export function WorkerUpdateNotice() {
  return (
    <Alert
      className="fdy-issue-worker-notice"
      tone="warning"
      title="这台设备的 Worker 需要更新"
    >
      <p>
        它可以澄清和验收，但还不能执行已确认的 Issue；确认后的 Issue
        会一直等待。在这台设备上运行{" "}
        <code>npx -y {workerPackageName}@latest update</code> 更新后即可执行。
      </p>
    </Alert>
  );
}

/** The list view's status cell: the state, and why when blocked. */
export function IssueListStatus({ issue }: { issue: Issue }) {
  const status = statusMeta(issueDisplayStatus(issue));
  const blocked = blockedReasonMeta(issue);
  return (
    <span title={blocked?.message}>
      <Badge tone={status.tone}>{status.label}</Badge>
      {blocked ? <small> · {blocked.label}</small> : null}
    </span>
  );
}
