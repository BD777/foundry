import { useRef, useState } from "react";
import { ArrowLeft, PanelRight, X } from "lucide-react";
import type { Issue, Run } from "@foundry/protocol";
import { EmptyState } from "../../components/ui/empty-state";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ScrollArea } from "../../components/ui/scroll-area";
import { ChatDetailSplitPane } from "../../components/conversation/chat-detail-split-pane";
import {
  issueDisplayId,
  issueDisplayStatus,
  statusMeta,
} from "../../lib/issue-meta";
import { IssueContractPanel } from "./issue-contract-panel";
import { IssueEvidencePanel } from "./issue-evidence-panel";
import { CandidateReview } from "./candidate-review";
import { IssueConversation } from "./issue-conversation";
import { IssueEnvironment } from "./issue-environment";
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
  // A new Issue owns a new draft, inspector selection and scroll position.
  if (!props.issue)
    return (
      <EmptyState
        title="Issue not found"
        body="Return to Issues to select a task."
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
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [detailsOpen, setDetailsOpen] = useState(
    () =>
      typeof window.matchMedia === "function" &&
      window.matchMedia("(min-width: 1100px)").matches,
  );
  const [tab, setTab] = useState<
    "details" | "changes" | "environment" | "evidence"
  >("details");
  const meta = statusMeta(issueDisplayStatus(issue));
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
            ? "正在整理标准…"
            : contract.draft?.criteria.length
              ? "请核对完成标准"
              : phase.title}
        </strong>
        <p>
          {contract.busy
            ? "Agent 正在处理；这一阶段不会启动实现。"
            : phase.next}
        </p>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            phase.tab === "details" ? focusComposer() : setTab(phase.tab)
          }
        >
          {phase.tab === "evidence"
            ? "查看验收结果"
            : phase.tab === "environment"
              ? "检查执行环境"
              : "回到主聊天"}
        </Button>
      </div>
      <header className="fdy-issue-details-toolbar">
        <Button
          size="sm"
          variant={tab === "details" ? "secondary" : "ghost"}
          onClick={() => setTab("details")}
        >
          目标与约定
        </Button>
        <Button
          size="sm"
          variant={tab === "evidence" ? "secondary" : "ghost"}
          onClick={() => setTab("evidence")}
        >
          验收结果
        </Button>
        <Button
          size="sm"
          variant={tab === "changes" ? "secondary" : "ghost"}
          onClick={() => setTab("changes")}
        >
          改动
        </Button>
        <Button
          size="sm"
          variant={tab === "environment" ? "secondary" : "ghost"}
          onClick={() => setTab("environment")}
        >
          执行环境
        </Button>
        <Button
          aria-label="Close issue details"
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
                查看运行位置、候选仓库及环境阻碍；一般不需要在这里操作。
              </p>
              <section className="fdy-issue-card">
                <h3>运行位置</h3>
                <dl className="fdy-issue-properties">
                  <dt>设备</dt>
                  <dd>{deviceLabel}</dd>
                  <dt>Workspace 基线</dt>
                  <dd>{workspaceBaseline}</dd>
                </dl>
              </section>
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
                <h3>还没有可审阅的改动</h3>
                <p>
                  确认标准并完成实现后，这里展示候选的实际文件差异。实现尚未开始时不会生成示例改动。
                </p>
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
              查看验收结果
            </Button>
            <Button variant="secondary" onClick={focusComposer}>
              要求修改
            </Button>
          </>
        ) : terminal ? (
          <Button
            variant="secondary"
            onClick={() =>
              callbacks.onDraftFromSource(
                `Follow up on ${issueDisplayId(issue)}: ${issue.title}\n\n${issue.sourceInput}`,
              )
            }
          >
            Create follow-up
          </Button>
        ) : (
          <Button variant="secondary" onClick={focusComposer}>
            {issue.status === "in_progress"
              ? "Guide this Issue"
              : "Continue conversation"}
          </Button>
        )}
        {!terminal ? (
          <Button
            variant="ghost"
            disabled={abandoning || issue.status === "in_progress"}
            title={
              issue.status === "in_progress"
                ? "Stop execution before abandoning"
                : "Retain history and candidate without integrating"
            }
            onClick={() => void abandon()}
          >
            {abandoning ? "Abandoning…" : "Abandon issue"}
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
            aria-label="Back to Issues"
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
              detailsOpen ? "Hide issue details" : "Show issue details"
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
          detailLabel="Issue details"
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
