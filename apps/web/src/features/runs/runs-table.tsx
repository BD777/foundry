import type { ReactNode } from "react";
import { ActionRow } from "../../components/ui/action-row";
import { Badge, type BadgeProps } from "../../components/ui/badge";
import { Panel } from "../../components/ui/panel";
import {
  runtimeMeta,
  type RuntimeKind,
} from "../../components/ui/runtime-mark";
import { ScrollArea } from "../../components/ui/scroll-area";
import {
  SegmentedControl,
  type SegmentOption,
} from "../../components/ui/segmented-control";

export interface RunsTableEvent {
  active?: boolean;
  detail?: ReactNode;
  id: string;
  label: ReactNode;
  when: ReactNode;
}

export interface RunsTableRow {
  duration: ReactNode;
  events: RunsTableEvent[];
  expanded?: boolean;
  id: string;
  issueId: ReactNode;
  issueTitle: ReactNode;
  onSelect: () => void;
  phase: ReactNode;
  running?: boolean;
  selected?: boolean;
  status: string;
  statusLabel: ReactNode;
  statusTone: BadgeProps["tone"];
  runtime: RuntimeKind;
}

export interface RunsTableProps {
  emptyState?: ReactNode;
  rows: RunsTableRow[];
}

export interface RunsToolbarProps {
  children: ReactNode;
}

export interface RunsFilterControlProps<T extends string> {
  ariaLabel?: string;
  onValueChange: (value: T) => void;
  options: Array<SegmentOption<T>>;
  value: T;
}

export function RunsFilterControl<T extends string>({
  ariaLabel = "Run status filter",
  onValueChange,
  options,
  value,
}: RunsFilterControlProps<T>) {
  return (
    <SegmentedControl
      aria-label={ariaLabel}
      className="fdy-runs-filter"
      onValueChange={onValueChange}
      options={options}
      value={value}
    />
  );
}

export function RunsToolbar({ children }: RunsToolbarProps) {
  return <div className="fdy-runs-toolbar">{children}</div>;
}

export function RunsTable({ emptyState, rows }: RunsTableProps) {
  return (
    <Panel className="fdy-runs-table-panel">
      <ScrollArea className="fdy-runs-table-scroll" aria-label="Runs table">
        <div className="fdy-runs-table-inner">
          <div className="fdy-runs-table-head">
            <span>Run</span>
            <span>Issue</span>
            <span>Runtime</span>
            <span>Phase</span>
            <span>Duration</span>
            <span>Status</span>
          </div>
          {rows.map((row) => (
            <RunsTableGroup key={row.id} row={row} />
          ))}
        </div>
      </ScrollArea>
      <div className="fdy-runs-mobile-list" aria-label="Runs list">
        {rows.map((row) => (
          <RunsMobileCard key={row.id} row={row} />
        ))}
      </div>
      {rows.length === 0 ? emptyState : null}
    </Panel>
  );
}

interface RunsTableGroupProps {
  row: RunsTableRow;
}

function RunsTableGroup({ row }: RunsTableGroupProps) {
  return (
    <div className="fdy-runs-table-group" data-status={row.status}>
      <ActionRow
        aria-expanded={row.expanded}
        className="fdy-runs-table-row"
        data-status={row.status}
        onClick={row.onSelect}
        selected={row.selected}
        variant="table"
      >
        <span>{row.id}</span>
        <span className="fdy-run-issue-cell">
          <strong>{row.issueTitle}</strong>
          <code>{row.issueId}</code>
        </span>
        <RunRuntimeCell runtime={row.runtime} />
        <span className="fdy-run-phase-cell">
          {row.running ? <i /> : null}
          {row.phase}
        </span>
        <span>{row.duration}</span>
        <span className="fdy-runs-table-status-cell">
          <Badge tone={row.statusTone}>{row.statusLabel}</Badge>
        </span>
      </ActionRow>
      {row.expanded ? <RunExpandedEvents events={row.events} /> : null}
    </div>
  );
}

function RunsMobileCard({ row }: RunsTableGroupProps) {
  return (
    <div className="fdy-runs-mobile-group" data-status={row.status}>
      <ActionRow
        aria-expanded={row.expanded}
        className="fdy-runs-mobile-card"
        data-status={row.status}
        onClick={row.onSelect}
        selected={row.selected}
      >
        <span className="fdy-runs-mobile-topline">
          <code>{row.id}</code>
          <Badge tone={row.statusTone}>{row.statusLabel}</Badge>
        </span>
        <strong>{row.issueTitle}</strong>
        <span className="fdy-runs-mobile-issue">{row.issueId}</span>
        <span className="fdy-runs-mobile-meta">
          <span>
            <em>Runtime</em>
            <RunRuntimeCell runtime={row.runtime} />
          </span>
          <span>
            <em>Phase</em>
            <strong className="fdy-run-phase-cell">
              {row.running ? <i /> : null}
              {row.phase}
            </strong>
          </span>
          <span>
            <em>Duration</em>
            <strong>{row.duration}</strong>
          </span>
        </span>
      </ActionRow>
      {row.expanded ? <RunExpandedEvents events={row.events} /> : null}
    </div>
  );
}

function RunRuntimeCell({ runtime }: { runtime: RuntimeKind }) {
  return (
    <span className="fdy-run-runtime-cell">{runtimeMeta(runtime).label}</span>
  );
}

interface RunExpandedEventsProps {
  events: RunsTableEvent[];
}

function RunExpandedEvents({ events }: RunExpandedEventsProps) {
  return (
    <div className="fdy-run-expanded">
      {events.map((event) => (
        <div
          className="fdy-run-trace-item"
          data-state={event.active ? "active" : "done"}
          key={event.id}
        >
          <span className="fdy-run-trace-rail">
            <span className="fdy-run-trace-node" />
            <span className="fdy-run-trace-line" />
          </span>
          <span className="fdy-run-trace-body">
            <strong>{event.label}</strong>
            <code>{event.when}</code>
          </span>
        </div>
      ))}
    </div>
  );
}
