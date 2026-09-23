import { Plus } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import type { IssueStatus } from "@foundry/protocol";
import { cn } from "../../lib/cn";
import { ActionRow } from "../../components/ui/action-row";
import { Button } from "../../components/ui/button";
import { StatusDot } from "../../components/ui/meta-pill";
import { Panel } from "../../components/ui/panel";
import { ScrollArea } from "../../components/ui/scroll-area";
import { Tooltip } from "../../components/ui/tooltip";

export function IssuesScreen({
  className,
  ...props
}: HTMLAttributes<HTMLElement>) {
  return <section className={cn("fdy-issues-screen", className)} {...props} />;
}

export interface IssueBoardColumnConfig {
  label: string;
  status: IssueStatus;
}

export interface IssueBoardItem {
  content: ReactNode;
  id: string;
  status: IssueStatus;
}

export interface IssueBoardProps {
  columns: IssueBoardColumnConfig[];
  issues: IssueBoardItem[];
  onAdd: (status: IssueStatus) => void;
}

export function IssueBoard({ columns, issues, onAdd }: IssueBoardProps) {
  return (
    <ScrollArea className="fdy-board-scroll">
      <div className="fdy-issue-board">
        {columns.map((column) => {
          const cards = issues.filter(
            (issue) => issue.status === column.status,
          );
          return (
            <section className="fdy-issue-column" key={column.status}>
              <header className="fdy-issue-column-header">
                <div className="fdy-issue-column-title">
                  <StatusDot status={column.status} />
                  <strong>{column.label}</strong>
                  <span className="fdy-issue-column-count">{cards.length}</span>
                </div>
                <Tooltip content={`Add ${column.label} issue`}>
                  <Button
                    aria-label={`Add ${column.label} issue`}
                    onClick={() => onAdd(column.status)}
                    size="icon"
                    variant="icon"
                  >
                    <Plus size={14} />
                  </Button>
                </Tooltip>
              </header>
              <ScrollArea className="fdy-issue-column-scroll">
                <div className="fdy-issue-column-stack">
                  {cards.map((issue) => (
                    <div key={issue.id}>{issue.content}</div>
                  ))}
                  {cards.length === 0 ? (
                    <div className="fdy-column-empty">No issues</div>
                  ) : null}
                </div>
              </ScrollArea>
            </section>
          );
        })}
      </div>
    </ScrollArea>
  );
}

export interface IssueListRow {
  id: string;
  issueId: ReactNode;
  onOpen: () => void;
  runtimeLabel: ReactNode;
  selected?: boolean;
  status: ReactNode;
  title: ReactNode;
  updatedLabel: ReactNode;
}

export interface IssueListTableProps {
  rows: IssueListRow[];
}

export function IssueListTable({ rows }: IssueListTableProps) {
  return (
    <Panel className="fdy-issue-list-panel">
      <ScrollArea className="fdy-issue-list-scroll">
        <div className="fdy-issue-list-head">
          <span>ID</span>
          <span>Issue</span>
          <span>Status</span>
          <span>Runtime</span>
          <span>Updated</span>
        </div>
        {rows.map((row) => (
          <ActionRow
            className="fdy-issue-list-row"
            key={row.id}
            onClick={row.onOpen}
            selected={row.selected}
            variant="table"
          >
            <span>{row.issueId}</span>
            <strong>{row.title}</strong>
            <span>{row.status}</span>
            <span>{row.runtimeLabel}</span>
            <span>{row.updatedLabel}</span>
          </ActionRow>
        ))}
      </ScrollArea>
      <div className="fdy-issue-list-cards">
        {rows.map((row) => (
          <ActionRow
            className="fdy-issue-list-card"
            key={row.id}
            onClick={row.onOpen}
            selected={row.selected}
          >
            <span className="fdy-issue-list-card-topline">
              <code>{row.issueId}</code>
              <span className="fdy-issue-list-card-status">{row.status}</span>
            </span>
            <strong>{row.title}</strong>
            <span className="fdy-issue-list-card-meta">
              <span>
                <em>Runtime</em>
                <strong>{row.runtimeLabel}</strong>
              </span>
              <span>
                <em>Updated</em>
                <strong>{row.updatedLabel}</strong>
              </span>
            </span>
          </ActionRow>
        ))}
      </div>
    </Panel>
  );
}
