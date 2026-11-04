import { Plus } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { IssueStatus } from "@bd777/foundry-protocol";
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
  return (
    <section
      className={cn(
        "flex h-full min-h-0 animate-page-fade flex-col overflow-hidden max-[860px]:h-auto max-[860px]:overflow-visible",
        className,
      )}
      {...props}
    />
  );
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
  const { t } = useTranslation("issues");
  return (
    // Six columns rarely fit; a visible scrollbar shows there is more.
    <ScrollArea
      className="box-border min-h-0 w-full flex-1 px-6 pt-4.5 pb-5.5 max-[860px]:max-w-full max-[860px]:overflow-visible max-[860px]:px-5.5 max-[860px]:pt-3.5 max-[860px]:pb-6"
      direction="both"
      viewportClassName="max-[860px]:max-w-full"
    >
      <div className="flex h-full w-max min-w-full gap-3.5 max-[860px]:box-border max-[860px]:h-auto max-[860px]:w-full max-[860px]:max-w-full max-[860px]:min-w-0 max-[860px]:flex-col">
        {columns.map((column) => {
          const cards = issues.filter(
            (issue) => issue.status === column.status,
          );
          return (
            <section
              className="flex min-h-0 w-72 max-w-72 min-w-72 flex-none flex-col max-[860px]:w-full max-[860px]:max-w-full max-[860px]:min-w-0"
              key={column.status}
            >
              <header className="box-border flex min-w-0 flex-none items-center gap-2 px-1 pb-2.5">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <StatusDot status={column.status} />
                  <strong className="block truncate text-xs leading-snug font-bold text-ink">
                    {column.label}
                  </strong>
                  <span className="h-auto min-w-0 flex-none rounded-full bg-chip px-[7px] py-[3px] text-center font-mono text-2xs leading-none font-semibold text-chip-ink">
                    {cards.length}
                  </span>
                </div>
                <Tooltip content={t("board.add", { status: column.label })}>
                  <Button
                    aria-label={t("board.add", { status: column.label })}
                    className="size-5.5 rounded-sm text-ink-faint hover:bg-control-ghost-hover hover:text-ink-muted"
                    onClick={() => onAdd(column.status)}
                    size="icon"
                    variant="icon"
                  >
                    <Plus size={14} />
                  </Button>
                </Tooltip>
              </header>
              <ScrollArea className="min-h-0 flex-1 max-[860px]:flex-none">
                <div className="flex min-w-0 flex-col gap-2.25 px-1 pt-0.5 pb-2">
                  {cards.map((issue) => (
                    <div
                      className="min-w-0 max-[860px]:box-border max-[860px]:max-w-full"
                      key={issue.id}
                    >
                      {issue.content}
                    </div>
                  ))}
                  {cards.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-line p-3.5 text-center text-2xs leading-[1.4] font-medium text-ink-faint">
                      {t("board.empty")}
                    </div>
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
  /** The status as the stacked cards show it, where the column is narrower. */
  cardStatus?: ReactNode;
  title: ReactNode;
  updatedLabel: ReactNode;
}

export interface IssueListTableProps {
  rows: IssueListRow[];
}

const listGrid =
  "box-border grid w-full min-w-[676px] grid-cols-[60px_minmax(220px,1fr)_132px_96px_84px] items-center gap-3";

export function IssueListTable({ rows }: IssueListTableProps) {
  const { t } = useTranslation("issues");
  return (
    <div className="mx-auto mt-4.5 mb-10 w-[calc(100%-48px)] max-w-[1000px]">
      <Panel className="overflow-hidden">
        <ScrollArea className="w-full max-[860px]:hidden">
          <div
            className={cn(
              listGrid,
              "border-b border-line-soft px-4.5 py-2.75 text-2xs leading-none font-semibold text-ink-faint uppercase",
            )}
          >
            <span>{t("list.id")}</span>
            <span>{t("list.issue")}</span>
            <span>{t("list.status")}</span>
            <span>{t("list.runtime")}</span>
            <span>{t("list.updated")}</span>
          </div>
          {rows.map((row) => (
            <ActionRow
              className={cn(
                listGrid,
                "relative min-h-[45px] border-t border-line-soft bg-transparent px-4.5 py-3.25 hover:bg-panel-soft",
              )}
              key={row.id}
              onClick={row.onOpen}
              selected={row.selected}
              variant="table"
            >
              <span className="min-w-0 truncate font-mono text-2xs leading-tight font-semibold text-ink-faint">
                {row.issueId}
              </span>
              <strong className="min-w-0 truncate text-sm leading-[1.3] font-semibold text-ink">
                {row.title}
              </strong>
              <span className="inline-flex min-w-0 items-center text-2xs font-semibold text-ink-faint">
                {row.status}
              </span>
              <span className="min-w-0 truncate text-xs leading-tight font-medium text-ink-muted">
                {row.runtimeLabel}
              </span>
              <span className="min-w-0 truncate font-mono text-2xs leading-tight font-medium text-ink-faint">
                {row.updatedLabel}
              </span>
            </ActionRow>
          ))}
        </ScrollArea>
        <div className="hidden w-full max-[860px]:block">
          {rows.map((row) => (
            <ActionRow
              className="relative box-border flex max-w-full flex-col items-stretch gap-2 border-line-soft bg-transparent px-3.5 py-3 first:border-t-0 hover:bg-surface"
              key={row.id}
              onClick={row.onOpen}
              selected={row.selected}
              variant="table"
            >
              <span className="flex min-w-0 items-center justify-between gap-2.5">
                <code className="min-w-0 truncate font-mono text-2xs leading-tight font-semibold text-ink-faint">
                  {row.issueId}
                </code>
                <span className="inline-flex min-w-0 flex-none items-center">
                  {row.cardStatus ?? row.status}
                </span>
              </span>
              <strong className="min-w-0 truncate text-md leading-tight font-semibold text-ink">
                {row.title}
              </strong>
              <span className="flex min-w-0 flex-nowrap items-center gap-x-3 gap-y-2">
                <ListCardMeta label={t("list.runtime")} grow>
                  {row.runtimeLabel}
                </ListCardMeta>
                <ListCardMeta label={t("list.updated")}>
                  {row.updatedLabel}
                </ListCardMeta>
              </span>
            </ActionRow>
          ))}
        </div>
      </Panel>
    </div>
  );
}

function ListCardMeta({
  children,
  grow = false,
  label,
}: {
  children: ReactNode;
  grow?: boolean;
  label: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-baseline gap-1.5 overflow-hidden",
        grow ? "flex-[1_1_auto]" : "flex-none",
      )}
    >
      <em className="inline-block min-w-0 truncate text-2xs leading-tight font-semibold text-ink-faint uppercase not-italic">
        {label}
      </em>
      <strong className="inline-block min-w-0 truncate text-2xs leading-tight font-medium text-ink">
        {children}
      </strong>
    </span>
  );
}
