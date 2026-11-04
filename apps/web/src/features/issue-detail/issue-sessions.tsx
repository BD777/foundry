import { ToastFeedback } from "../../components/ui/toast";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import type { AgentSession, Issue } from "@bd777/foundry-protocol";
import { listIssueSessions } from "../../api";
import { ActionRow } from "../../components/ui/action-row";
import { Badge } from "../../components/ui/badge";
import { HelpHint } from "../../components/ui/help-hint";
import { RuntimeMark } from "../../components/agent-runtime/runtime-mark";
import { navigateToChat } from "../../lib/in-app-navigation";
import { runStatusLabel } from "../../lib/run-meta";
import { IssueSection } from "./issue-section";

/**
 * The sessions that worked for this Issue and who started each: its
 * clarification, its executions and the sessions an execution started. Each
 * opens its full transcript in Chats.
 */
export function IssueSessions({ issue }: { issue: Issue }) {
  const { t } = useTranslation("issueDetail");
  const [sessions, setSessions] = useState<AgentSession[]>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!issue.workspaceId) return;
    let active = true;
    listIssueSessions(issue.workspaceId, issue.id).then(
      (items) => {
        if (!active) return;
        setSessions(items);
        setError("");
      },
      (reason) => active && setError(String(reason)),
    );
    return () => {
      active = false;
    };
  }, [issue.id, issue.workspaceId, issue.status, issue.run?.id]);
  const byId = new Map(sessions?.map((session) => [session.id, session]));
  const role = (session: AgentSession) =>
    session.role === "issue_execution"
      ? t("sessions.execution")
      : session.role === "issue_clarification"
        ? t("sessions.clarification")
        : t("sessions.helper");
  const origin = (session: AgentSession) => {
    const parent = session.parentSessionId
      ? byId.get(session.parentSessionId)
      : undefined;
    return parent
      ? t("sessions.startedBy", { role: role(parent).toLowerCase() })
      : "";
  };
  return (
    <IssueSection>
      <h3 className="flex items-center gap-1.5">
        {t("sessions.title")}
        <HelpHint label={t("sessions.help")}>{t("sessions.intro")}</HelpHint>
      </h3>
      {error ? <ToastFeedback tone="error" title={error} /> : null}
      {sessions && !sessions.length ? <p>{t("sessions.none")}</p> : null}
      {sessions?.map((session) => (
        <ActionRow
          className="gap-2.5"
          density="compact"
          key={session.id}
          onClick={() => navigateToChat(session.id)}
          aria-label={t("sessions.open", { role: role(session) })}
        >
          <RuntimeMark runtime={session.provider} size="chat" />
          <span className="grid min-w-0 flex-1">
            <strong>{role(session)}</strong>
            <span className="truncate text-ink-muted">
              {origin(session) || session.title}
            </span>
          </span>
          <Badge tone={session.status === "failed" ? "error" : "neutral"}>
            {runStatusLabel(session.status)}
          </Badge>
          <ChevronRight aria-hidden size={14} />
        </ActionRow>
      ))}
    </IssueSection>
  );
}
