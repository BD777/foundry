import { ArrowLeft } from "lucide-react";
import { Children, type ReactNode } from "react";
import { Badge, type BadgeProps } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ScrollArea } from "../../components/ui/scroll-area";

type BadgeTone = NonNullable<BadgeProps["tone"]>;

export interface IssueDetailScreenProps {
  children: ReactNode;
  inspector: ReactNode;
}

export function IssueDetailScreen({
  children,
  inspector,
}: IssueDetailScreenProps) {
  const [header, ...body] = Children.toArray(children);

  return (
    <section className="fdy-issue-detail-screen">
      <ScrollArea
        className="fdy-issue-detail-main"
        data-foundry-scroll-reset-viewport="true"
      >
        <div className="fdy-issue-detail-content">
          {header}
          {body}
          <div className="fdy-issue-inspector-mobile">{inspector}</div>
        </div>
      </ScrollArea>
      <div className="fdy-issue-inspector-desktop">{inspector}</div>
    </section>
  );
}

export interface IssueDetailHeaderProps {
  artifactLabel: ReactNode;
  issueId: ReactNode;
  onBack: () => void;
  runLabel?: ReactNode;
  runtimeLabel: ReactNode;
  statusLabel: ReactNode;
  statusTone: BadgeTone;
  title: ReactNode;
}

export function IssueDetailHeader({
  artifactLabel,
  issueId,
  onBack,
  runLabel,
  runtimeLabel,
  statusLabel,
  statusTone,
  title,
}: IssueDetailHeaderProps) {
  return (
    <header className="fdy-issue-detail-header">
      <Button
        className="fdy-issue-back-button"
        onClick={onBack}
        size="sm"
        variant="ghost"
      >
        <ArrowLeft size={14} />
        Issues
      </Button>
      <div className="fdy-issue-detail-title-row">
        <h1>{title}</h1>
        <code>{issueId}</code>
        <Badge tone={statusTone}>{statusLabel}</Badge>
      </div>
      <p className="fdy-issue-detail-subtitle">
        Primary artifact: <strong>{artifactLabel}</strong> · {runtimeLabel}
        {runLabel ? (
          <>
            {" "}
            · run <code>{runLabel}</code>
          </>
        ) : null}
      </p>
    </header>
  );
}

export interface IssueContractBodyProps {
  inferredTask: ReactNode;
  sourceInput: ReactNode;
}

export function IssueContractBody({
  inferredTask,
  sourceInput,
}: IssueContractBodyProps) {
  return (
    <div className="fdy-issue-contract-body fdy-issue-conversation">
      <article className="fdy-issue-turn" data-role="user">
        <span>User</span>
        <p>{sourceInput}</p>
      </article>
      <article className="fdy-issue-turn" data-role="bot">
        <span>Foundry</span>
        <p>{inferredTask}</p>
      </article>
    </div>
  );
}
