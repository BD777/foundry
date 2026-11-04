import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, PanelRight, X } from "lucide-react";
import type { Issue } from "@bd777/foundry-protocol";
import { EmptyState } from "../../components/ui/empty-state";
import { Badge } from "../../components/ui/badge";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { HelpHint } from "../../components/ui/help-hint";
import { viewFillClassName } from "../../components/ui/app-shell";
import { ScrollArea } from "../../components/ui/scroll-area";
import { cn } from "../../lib/cn";
import { ChatDetailSplitPane } from "../../components/conversation/chat-detail-split-pane";
import {
  ChatScreen,
  ChatThread,
  ChatThreadTitle,
  ConversationHeader,
} from "../../components/conversation/conversation-frame";
import {
  isIssueClosed,
  issueBadgeMeta,
  issueDisplayId,
} from "../../lib/issue-meta";
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
import { IssueSection } from "./issue-section";
import type { ExecutionTranscript } from "./issue-transcript";

export interface IssueDetailViewProps {
  issue: Issue | undefined;
  /** The Issue a link names is being opened in its own workspace. */
  opening?: boolean;
  workspaceBaseline: string;
  deviceLabel: string;
  onBack: () => void;
  callbacks: IssueActionCallbacks;
  /** How its executions show: as a chat shows sessions. */
  executionTranscript: ExecutionTranscript;
}

export function IssueDetailView(props: IssueDetailViewProps) {
  const { t } = useTranslation("issueDetail");
  // A new Issue owns a new draft, inspector selection and scroll position.
  if (!props.issue && props.opening)
    return (
      <EmptyState title={t("view.openingTitle")} body={t("view.openingBody")} />
    );
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
  workspaceBaseline,
  deviceLabel,
  onBack,
  callbacks,
  executionTranscript,
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
  const contract = useIssueContract(issue);
  const phase = issuePhase(issue);
  const [abandoning, setAbandoning] = useState(false);
  const terminal = isIssueClosed(issue);
  const abandon = async () => {
    if (abandoning) return;
    setAbandoning(true);
    try {
      await abandonIssue(issue.id, issue.run?.id);
    } catch (error) {
      callbacks.onNotice(String(error), "error");
    } finally {
      setAbandoning(false);
    }
  };
  const focusComposer = () => {
    if (!window.matchMedia("(min-width: 1100px)").matches)
      setDetailsOpen(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const tabHelp =
    tab === "details"
      ? t("contractPanel.intro")
      : tab === "evidence"
        ? t("evidence.intro")
        : tab === "environment"
          ? t("view.environmentIntro")
          : undefined;
  const inspector = (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="border-b border-line px-4 py-3">
        <Alert
          actions={
            <Button
              size="sm"
              variant="secondary"
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
          }
          title={
            contract.busy
              ? t("view.organizing")
              : contract.draft?.criteria.length
                ? t("view.reviewDraft")
                : phase.title
          }
        >
          {contract.busy ? t("view.organizingNext") : phase.next}
        </Alert>
      </div>
      <header className="flex flex-wrap gap-2 border-b border-line px-4 py-3">
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
        <div className="ml-auto flex items-center gap-1">
          {tabHelp ? (
            <HelpHint label={t("view.tabHelp")}>{tabHelp}</HelpHint>
          ) : null}
          <Button
            aria-label={t("view.closeDetails")}
            size="icon"
            variant="ghost"
            onClick={() => setDetailsOpen(false)}
          >
            <X size={16} />
          </Button>
        </div>
      </header>
      <ScrollArea key={tab} className="min-h-0 flex-1">
        <div className="flex flex-col gap-6 p-6 text-sm leading-[1.6] wrap-anywhere">
          {tab === "evidence" ? (
            <IssueEvidencePanel issue={issue} />
          ) : tab === "environment" ? (
            <>
              <IssueSection>
                <h3>{t("view.location")}</h3>
                <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2.5">
                  <dt className="text-ink-muted">{t("view.device")}</dt>
                  <dd className="m-0">{deviceLabel}</dd>
                  <dt className="text-ink-muted">{t("view.baseline")}</dt>
                  <dd className="m-0">{workspaceBaseline}</dd>
                </dl>
              </IssueSection>
              <IssueSessions issue={issue} />
              <IssueEnvironment issue={issue} />
            </>
          ) : tab === "changes" ? (
            issue.run?.environmentId &&
            ["verifying", "accepted"].includes(issue.status) ? (
              <CandidateReview
                issueId={issue.id}
                revision={issue.run.environmentRevision ?? 0}
              />
            ) : (
              <IssueSection>
                <h3>{t("view.noChangesTitle")}</h3>
                <p>{t("view.noChangesBody")}</p>
              </IssueSection>
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
      <footer className="flex flex-wrap gap-2 border-t border-line px-4 py-3">
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
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              disabled={abandoning || issue.status === "in_progress"}
              onClick={() => void abandon()}
            >
              {abandoning ? t("view.abandoning") : t("view.abandon")}
            </Button>
            <HelpHint label={t("view.abandonHelp")}>
              {issue.status === "in_progress"
                ? t("view.abandonBlocked")
                : t("view.abandonHint")}
            </HelpHint>
          </div>
        ) : null}
      </footer>
    </div>
  );
  return (
    <ChatScreen
      className={cn(
        "min-h-0 overflow-hidden max-[860px]:flex-1",
        viewFillClassName,
      )}
    >
      <ChatThread>
        <ConversationHeader>
          <Button
            aria-label={t("view.back")}
            size="icon"
            variant="ghost"
            onClick={onBack}
          >
            <ArrowLeft size={16} />
          </Button>
          <ChatThreadTitle
            caption={`${issueDisplayId(issue)} · ${phase.title}`}
            title={issue.title}
          />
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
        </ConversationHeader>
        <ChatDetailSplitPane
          detail={detailsOpen ? inspector : undefined}
          detailLabel={t("view.detailsLabel")}
        >
          <IssueConversation
            issue={issue}
            inputRef={inputRef}
            contract={contract}
            executionTranscript={executionTranscript}
          />
        </ChatDetailSplitPane>
      </ChatThread>
    </ChatScreen>
  );
}
