import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, PanelRight, X } from "lucide-react";
import type { Issue, Run } from "@bd777/foundry-protocol";
import { EmptyState } from "../../components/ui/empty-state";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ScrollArea } from "../../components/ui/scroll-area";
import { ChatDetailSplitPane } from "../../components/conversation/chat-detail-split-pane";
import { issueBadgeMeta, issueDisplayId } from "../../lib/issue-meta";
import { IssueContractPanel } from "./issue-contract-panel";
import { IssueEvidencePanel } from "./issue-evidence-panel";
import { CandidateReview } from "./candidate-review";
import { IssueConversation } from "./issue-conversation";
import { IssueEnvironment } from "./issue-environment";
import { IssueSessions } from "./issue-sessions";
import type { IssueActionCallbacks } from "./issue-actions";
import { abandonIssue } from "../../api";
import { useIssueContract } from "./use-issue-contract";
import { issuePhase } from "./issue-language";
import "./issue-execution.css";

export interface IssueDetailViewProps {
  issue: Issue | undefined;
  history?: Run[];
  workspaceBaseline: string;
  deviceLabel: string;
  onBack: () => void;
  callbacks: IssueActionCallbacks;
}

export function IssueDetailView(props: IssueDetailViewProps) {
  const { t } = useTranslation("issueDetail");
  // A new Issue owns a new draft, inspector selection and scroll position.
  if (!props.issue)
    return (
      <EmptyState
        title={t("view.notFoundTitle")}
        body={t("view.notFoundBody")}
      />
    );
  return <IssueDetail key={props.issue.id} {...props} issue={props.issue} />;
}

function IssueDetail({
  issue,
  history,
  workspaceBaseline,
  deviceLabel,
  onBack,
  callbacks,
}: IssueDetailViewProps & { issue: Issue }) {
  const { t } = useTranslation("issueDetail");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [detailsOpen, setDetailsOpen] = useState(
    () =>
      typeof window.matchMedia === "function" &&
      window.matchMedia("(min-width: 1100px)").matches,
  );
  const [tab, setTab] = useState<
    "details" | "changes" | "environment" | "evidence"
  >("details");
  const meta = issueBadgeMeta(issue);
  const contract = useIssueContract(issue, callbacks.onRefresh);
  const phase = issuePhase(issue);
  const [abandoning, setAbandoning] = useState(false);
  const terminal = issue.status === "accepted" || issue.status === "abandoned";
  const abandon = async () => {
    if (abandoning) return;
    setAbandoning(true);
    try {
      await abandonIssue(issue.id, issue.run?.id);
      callbacks.onRefresh(issue.id);
    } catch (error) {
      callbacks.onNotice(String(error));
    } finally {
      setAbandoning(false);
    }
  };
  const focusComposer = () => {
    if (!window.matchMedia("(min-width: 1100px)").matches)
      setDetailsOpen(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const inspector = (
    <div className="fdy-issue-details-panel">
      <div className="fdy-issue-phase" role="status">
        <strong>
          {contract.busy
            ? t("view.organizing")
            : contract.draft?.criteria.length
              ? t("view.reviewDraft")
              : phase.title}
        </strong>
        <p>{contract.busy ? t("view.organizingNext") : phase.next}</p>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            phase.tab === "details" ? focusComposer() : setTab(phase.tab)
          }
        >
          {phase.tab === "evidence"
            ? t("view.gotoEvidence")
            : phase.tab === "environment"
              ? t("view.gotoEnvironment")
              : t("view.gotoChat")}
        </Button>
      </div>
      <header className="fdy-issue-details-toolbar">
        <Button
          size="sm"
          variant={tab === "details" ? "secondary" : "ghost"}
          onClick={() => setTab("details")}
        >
          {t("view.tabs.details")}
        </Button>
        <Button
          size="sm"
          variant={tab === "evidence" ? "secondary" : "ghost"}
          onClick={() => setTab("evidence")}
        >
          {t("view.tabs.evidence")}
        </Button>
        <Button
          size="sm"
          variant={tab === "changes" ? "secondary" : "ghost"}
          onClick={() => setTab("changes")}
        >
          {t("view.tabs.changes")}
        </Button>
        <Button
          size="sm"
          variant={tab === "environment" ? "secondary" : "ghost"}
          onClick={() => setTab("environment")}
        >
          {t("view.tabs.environment")}
        </Button>
        <Button
          aria-label={t("view.closeDetails")}
          size="icon"
          variant="ghost"
          onClick={() => setDetailsOpen(false)}
        >
          <X size={16} />
        </Button>
      </header>
      <ScrollArea key={tab} className="fdy-issue-details-scroll">
        <div className="fdy-issue-details-content">
          {tab === "evidence" ? (
            <IssueEvidencePanel issue={issue} onRefresh={callbacks.onRefresh} />
          ) : tab === "environment" ? (
            <>
              <p className="fdy-issue-tab-intro">
                {t("view.environmentIntro")}
              </p>
              <section className="fdy-issue-card">
                <h3>{t("view.location")}</h3>
                <dl className="fdy-issue-properties">
                  <dt>{t("view.device")}</dt>
                  <dd>{deviceLabel}</dd>
                  <dt>{t("view.baseline")}</dt>
                  <dd>{workspaceBaseline}</dd>
                </dl>
              </section>
              <IssueSessions issue={issue} />
              <IssueEnvironment issue={issue} onRefresh={callbacks.onRefresh} />
            </>
          ) : tab === "changes" ? (
            issue.run?.environmentId &&
            ["verifying", "accepted"].includes(issue.status) ? (
              <CandidateReview
                issueId={issue.id}
                revision={issue.run.environmentRevision ?? 0}
              />
            ) : (
              <section className="fdy-issue-card">
                <h3>{t("view.noChangesTitle")}</h3>
                <p>{t("view.noChangesBody")}</p>
              </section>
            )
          ) : (
            <IssueContractPanel
              issue={issue}
              controller={contract}
              onDiscuss={focusComposer}
            />
          )}
        </div>
      </ScrollArea>
      <footer className="fdy-issue-details-actions">
        {issue.status === "verifying" ? (
          <>
            <Button
              variant="primary"
              disabled={abandoning}
              onClick={() => setTab("evidence")}
            >
              {t("view.gotoEvidence")}
            </Button>
            <Button variant="secondary" onClick={focusComposer}>
              {t("view.requestChanges")}
            </Button>
          </>
        ) : terminal ? (
          <Button
            variant="secondary"
            onClick={() =>
              callbacks.onDraftFromSource(
                t("view.followUpDraft", {
                  id: issueDisplayId(issue),
                  title: issue.title,
                  source: issue.sourceInput,
                }),
              )
            }
          >
            {t("view.createFollowUp")}
          </Button>
        ) : (
          <Button variant="secondary" onClick={focusComposer}>
            {issue.status === "in_progress"
              ? t("view.guide")
              : t("view.continue")}
          </Button>
        )}
        {!terminal ? (
          <Button
            variant="ghost"
            disabled={abandoning || issue.status === "in_progress"}
            title={
              issue.status === "in_progress"
                ? t("view.abandonBlocked")
                : t("view.abandonHint")
            }
            onClick={() => void abandon()}
          >
            {abandoning ? t("view.abandoning") : t("view.abandon")}
          </Button>
        ) : null}
      </footer>
    </div>
  );
  return (
    <section className="fdy-chat-screen fdy-issue-chat-screen">
      <div className="fdy-chat-thread">
        <header className="fdy-chat-thread-header">
          <Button
            aria-label={t("view.back")}
            size="icon"
            variant="ghost"
            onClick={onBack}
          >
            <ArrowLeft size={16} />
          </Button>
          <div className="fdy-chat-thread-title">
            <strong>{issue.title}</strong>
            <span>
              {issueDisplayId(issue)} · {phase.title}
            </span>
          </div>
          <Badge tone={meta.tone}>{meta.label}</Badge>
          <Button
            aria-label={
              detailsOpen ? t("view.hideDetails") : t("view.showDetails")
            }
            size="icon"
            variant="ghost"
            onClick={() => setDetailsOpen((open) => !open)}
          >
            <PanelRight size={17} />
          </Button>
        </header>
        <ChatDetailSplitPane
          detail={detailsOpen ? inspector : undefined}
          detailLabel={t("view.detailsLabel")}
        >
          <IssueConversation
            issue={issue}
            history={history}
            inputRef={inputRef}
            onRefresh={callbacks.onRefresh}
            contract={contract}
          />
        </ChatDetailSplitPane>
      </div>
    </section>
  );
}
