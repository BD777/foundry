import type { Issue } from "@bd777/foundry-protocol";
import { Trans, useTranslation } from "react-i18next";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import {
  blockedReasonMeta,
  issueDisplayStatus,
  statusMeta,
} from "../../lib/issue-meta";
import {
  localWorkerCommand,
  npxWorkerCommand,
} from "../../lib/worker-commands";

/** An older worker clarifies and verifies but cannot execute Issues. */
export function WorkerUpdateNotice() {
  const { t } = useTranslation("issues");
  return (
    <Alert
      className="fdy-issue-worker-notice"
      tone="warning"
      title={t("worker.title")}
    >
      <p>
        <Trans
          ns="issues"
          i18nKey="worker.body"
          values={{
            command: `${localWorkerCommand} update`,
            legacy: `${npxWorkerCommand} update`,
          }}
          components={{ code: <code /> }}
        />
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
