import {
  Activity,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  CircleStop,
  CircleX,
  Clock,
  Cog,
  ExternalLink,
  FolderClosed,
  LoaderCircle,
  Repeat,
  Terminal,
  Workflow,
  X,
} from "lucide-react";
import type { AgentBackgroundTask } from "@bd777/foundry-protocol";
import {
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "../../i18n";
import { Button } from "../../components/ui/button";
import {
  FileTree,
  type FileTreeItem,
  type FileTreeRoot,
} from "../../components/ui/file-tree";
import {
  formatDuration,
  subagentUsageSummary,
} from "../../components/conversation/turn-usage";
import { useSharedNow } from "./use-shared-now";
import { ChatSessionStatusLine } from "./chat-session-status";
import { timerNextRun } from "./chat-schedule-model";
import type {
  ChatBackgroundTaskItem,
  ChatContextCardData,
  ChatContextSelection,
  ChatContextResourceItem,
  ChatSessionFileItem,
  ChatSubagentItem,
  ChatTimerItem,
} from "./chat-types";

function ResourceRow({
  item,
  kind,
  onSelect,
  selected,
}: {
  item: ChatContextResourceItem;
  kind: "preview" | "source";
  onSelect?: (item: ChatContextSelection) => void;
  selected: boolean;
}) {
  return (
    <Button
      aria-pressed={selected}
      className="fdy-chat-context-row"
      data-selected={selected ? "true" : "false"}
      onClick={() => onSelect?.(item)}
      title={item.detail ?? item.label}
      variant="ghost"
    >
      <span className="fdy-chat-context-row-icon" data-kind={kind}>
        {item.kind === "web" ? (
          <ExternalLink size={16} />
        ) : (
          <FolderClosed size={16} />
        )}
      </span>
      <span className="fdy-chat-context-row-copy">
        <strong>{item.label}</strong>
        {item.detail && item.detail !== item.label ? (
          <em>{item.detail}</em>
        ) : null}
      </span>
    </Button>
  );
}

/**
 * Workspace files by their workspace path; others by absolute path. Changes
 * show Git-style A/M/D and their line counts: one turn's, or all turns'.
 */
function fileTreeRoots(
  items: ChatSessionFileItem[],
  changes: { turnId?: string } | undefined,
): FileTreeRoot[] {
  const asItem = (file: ChatSessionFileItem, path: string): FileTreeItem => {
    const status = i18n.t(`chat:contextCard.fileStatus.${file.op}`);
    const lineChanges = changes
      ? changes.turnId
        ? file.turnLineChanges?.[changes.turnId]
        : file.lineChanges
      : undefined;
    return {
      id: file.id,
      path,
      ...(changes && file.op !== "referenced"
        ? {
            status: i18n.t(`chat:contextCard.fileStatusShort.${file.op}`),
            statusLabel: status,
          }
        : { status }),
      ...(lineChanges ? { lineChanges } : {}),
      tone: file.op,
      title: file.path,
    };
  };
  const inside = items.filter((file) => file.workspacePath);
  const outside = items.filter((file) => !file.workspacePath);
  return [
    {
      id: "workspace",
      label: i18n.t("chat:contextCard.workspaceRoot"),
      items: inside.map((file) => asItem(file, file.workspacePath!)),
    },
    {
      id: "outside",
      label: i18n.t("chat:contextCard.outsideRoot"),
      items: outside.map((file) => asItem(file, file.path)),
    },
  ].filter((root) => root.items.length > 0);
}

function FileSection({
  changes,
  emptyLabel,
  files,
  label,
  onSelect,
  reveal,
  title,
}: {
  /** The section lists changes, from one turn (`turnId`) or all of them. */
  changes?: { turnId?: string };
  emptyLabel?: string;
  files: ChatSessionFileItem[];
  label: string;
  onSelect?: (item: ChatContextSelection) => void;
  reveal?: { ids: string[] };
  title: string;
}) {
  const turnId = changes?.turnId;
  const listsChanges = changes !== undefined;
  const roots = useMemo(
    () => fileTreeRoots(files, listsChanges ? { turnId } : undefined),
    [files, listsChanges, turnId],
  );
  const byId = useMemo(
    () => new Map(files.map((file) => [file.id, file])),
    [files],
  );
  const heading = (inRow: boolean) => (
    <h3 className={inRow ? "fdy-chat-context-heading" : undefined}>
      {title}
      {files.length > 0 ? (
        <span className="fdy-chat-context-count">{files.length}</span>
      ) : null}
    </h3>
  );
  return (
    <section className="fdy-chat-context-section">
      {files.length === 0 ? (
        <>
          {heading(false)}
          <p className="fdy-chat-context-empty">{emptyLabel}</p>
        </>
      ) : (
        <FileTree
          aria-label={label}
          heading={heading(true)}
          onSelect={(item) => {
            const file = byId.get(item.id);
            if (file)
              onSelect?.(turnId ? { ...file, diffTurnId: turnId } : file);
          }}
          reveal={reveal}
          roots={roots}
        />
      )}
    </section>
  );
}

/** Changes and Files: what the chat's tools wrote and its answers named. */
function SessionFileSections({
  data,
  onClearTurnFilter,
  onSelect,
  reveal,
  turnFilter,
}: {
  data: ChatContextCardData;
  onClearTurnFilter?: () => void;
  onSelect?: (item: ChatContextSelection) => void;
  reveal?: { ids: string[] };
  turnFilter?: string;
}) {
  const { t } = useTranslation("chat");
  const inTurn = (file: ChatSessionFileItem) =>
    !turnFilter || file.turnIds.includes(turnFilter);
  const changes = data.changes.filter(inTurn);
  const files = data.files.filter(inTurn);
  return (
    <>
      {turnFilter ? (
        <div className="fdy-chat-context-filter">
          <span>{t("contextCard.turnFilter")}</span>
          <Button onClick={onClearTurnFilter} size="sm" variant="ghost">
            {t("contextCard.showAllFiles")}
          </Button>
        </div>
      ) : null}
      {changes.length + files.length === 0 ? (
        <section className="fdy-chat-context-section">
          <h3>{t("contextCard.files")}</h3>
          <p className="fdy-chat-context-empty">
            {t("contextCard.filesEmpty")}
          </p>
        </section>
      ) : (
        <>
          <FileSection
            changes={{ turnId: turnFilter }}
            emptyLabel={t("contextCard.changesEmpty")}
            files={changes}
            label={t("contextCard.changesLabel")}
            onSelect={onSelect}
            reveal={reveal}
            title={t("contextCard.changes")}
          />
          {files.length > 0 ? (
            <FileSection
              files={files}
              label={t("contextCard.filesLabel")}
              onSelect={onSelect}
              reveal={reveal}
              title={t("contextCard.files")}
            />
          ) : null}
        </>
      )}
    </>
  );
}

function SubagentStatusIcon({
  status,
}: {
  status: ChatSubagentItem["status"];
}) {
  if (status === "running") {
    return <LoaderCircle aria-hidden="true" size={13} />;
  }
  if (status === "completed") {
    return <Check aria-hidden="true" size={13} />;
  }
  return <CircleX aria-hidden="true" size={13} />;
}

function formatNextFireLabel(iso?: string): string {
  if (!iso) {
    return "";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const isTomorrow = date.toDateString() === tomorrow.toDateString();
  const time = date.toLocaleTimeString(i18n.language, {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  if (sameDay) {
    return i18n.t("chat:contextCard.today", { time });
  }
  if (isTomorrow) {
    return i18n.t("chat:contextCard.tomorrow", { time });
  }
  return date.toLocaleString(i18n.language, {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function TimerRow({
  item,
  onSelect,
  selected,
}: {
  item: ChatTimerItem;
  onSelect?: (item: ChatContextSelection) => void;
  selected: boolean;
}) {
  const { t } = useTranslation("chat");
  // Only a timer the server's schedule holds fires. Recompute on each
  // render, from its last wake: the reported next fire goes stale within a
  // cycle.
  const scheduled = item.scheduled;
  const next = scheduled
    ? timerNextRun(scheduled, item.wake, item.busy)
    : undefined;
  const nextFire = formatNextFireLabel(
    next?.at?.toISOString() ?? scheduled?.nextFireAt,
  );
  const runningSince = item.running?.startedAt
    ? formatNextFireLabel(item.running.startedAt)
    : "";
  const status = !scheduled
    ? t("contextCard.timerInactive")
    : runningSince
      ? t("contextCard.timerRunning", { time: runningSince })
      : next?.due
        ? t(item.busy ? "contextCard.timerDue" : "contextCard.timerDueNow")
        : nextFire
          ? t("contextCard.nextFire", { time: nextFire })
          : "";
  const fireCount = item.fires.length;
  return (
    <Button
      aria-pressed={selected}
      className="fdy-chat-context-row fdy-chat-timer-row"
      data-selected={selected ? "true" : "false"}
      onClick={() => onSelect?.(item)}
      title={item.detail ?? item.label}
      variant="ghost"
    >
      <span className="fdy-chat-context-row-icon" data-kind="timer">
        {item.task.recurring ? (
          <Repeat aria-hidden="true" size={16} />
        ) : (
          <Clock aria-hidden="true" size={16} />
        )}
      </span>
      <span className="fdy-chat-context-row-copy">
        <strong>{item.label}</strong>
        <em>
          {status}
          {status && fireCount > 0 ? " · " : ""}
          {fireCount > 0
            ? t("contextCard.fireCount", { count: fireCount })
            : ""}
        </em>
      </span>
    </Button>
  );
}

export function BackgroundKindIcon({
  kind,
  size = 16,
}: {
  kind: AgentBackgroundTask["kind"];
  size?: number;
}) {
  if (kind === "command") return <Terminal aria-hidden="true" size={size} />;
  if (kind === "monitor") return <Activity aria-hidden="true" size={size} />;
  if (kind === "workflow") return <Workflow aria-hidden="true" size={size} />;
  if (kind === "subagent") return <Bot aria-hidden="true" size={size} />;
  return <Cog aria-hidden="true" size={size} />;
}

export function BackgroundStatusIcon({
  status,
}: {
  status: AgentBackgroundTask["status"];
}) {
  if (status === "running")
    return <LoaderCircle aria-hidden="true" size={13} />;
  if (status === "completed") return <Check aria-hidden="true" size={13} />;
  if (status === "failed") return <CircleX aria-hidden="true" size={13} />;
  if (status === "stopped") return <CircleStop aria-hidden="true" size={13} />;
  return <CircleDashed aria-hidden="true" size={13} />;
}

function backgroundElapsed(task: AgentBackgroundTask, now: number): number {
  const started = Date.parse(task.startedAt);
  const ended = task.endedAt ? Date.parse(task.endedAt) : now;
  return Number.isNaN(started) || Number.isNaN(ended)
    ? 0
    : Math.max(0, ended - started);
}

/** How long it ran and how it ended: "running 23m", "failed · exit 144". */
export function backgroundOutcome(
  task: AgentBackgroundTask,
  now: number,
): string {
  const duration = formatDuration(backgroundElapsed(task, now));
  const exit =
    task.exitCode !== undefined
      ? i18n.t("chat:contextCard.backgroundExit", { code: task.exitCode })
      : undefined;
  switch (task.status) {
    case "running":
      return i18n.t("chat:contextCard.backgroundRunningFor", { duration });
    case "completed":
      return [i18n.t("chat:contextCard.backgroundDoneIn", { duration }), exit]
        .filter(Boolean)
        .join(" · ");
    case "failed":
      return [i18n.t("chat:contextCard.backgroundFailed"), exit]
        .filter(Boolean)
        .join(" · ");
    case "stopped":
      return task.stopReason === "agent_exit"
        ? i18n.t("chat:contextCard.backgroundAgentExit")
        : i18n.t("chat:contextCard.backgroundStopped");
    default:
      return i18n.t("chat:contextCard.backgroundEnded");
  }
}

/** The row's second line: its kind in words, who started it, its outcome. */
export function backgroundRowDetail(
  item: ChatBackgroundTaskItem,
  now: number,
): string {
  return [
    i18n.t(`chat:contextCard.backgroundKind.${item.task.kind}`),
    item.ownerLabel
      ? i18n.t("chat:contextCard.backgroundFrom", { name: item.ownerLabel })
      : undefined,
    backgroundOutcome(item.task, now),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Open folds by chat and section, for this page's lifetime only. */
const openFolds = new Map<string, boolean>();

/**
 * Whether a section's finished rows are unfolded: remembered per chat while
 * the page lives, closed for a chat not seen yet.
 */
function useFoldOpen(
  memoryKey: string | undefined,
): [boolean, (open: boolean) => void] {
  const [local, setLocal] = useState(false);
  const [, setVersion] = useState(0);
  if (!memoryKey) return [local, setLocal];
  return [
    openFolds.get(memoryKey) ?? false,
    (open) => {
      openFolds.set(memoryKey, open);
      setVersion((version) => version + 1);
    },
  ];
}

/** Finished rows behind one "12 finished" row that opens and closes them. */
function FinishedFold({
  children,
  label,
  memoryKey,
}: {
  children: ReactNode;
  label: string;
  memoryKey?: string;
}) {
  const [open, setOpen] = useFoldOpen(memoryKey);
  const id = useId();
  return (
    <>
      <Button
        aria-controls={open ? id : undefined}
        aria-expanded={open}
        className="fdy-chat-context-fold"
        onClick={() => setOpen(!open)}
        size="sm"
        variant="ghost"
      >
        <span className="fdy-chat-context-fold-icon">
          {open ? (
            <ChevronDown aria-hidden="true" size={14} />
          ) : (
            <ChevronRight aria-hidden="true" size={14} />
          )}
        </span>
        {label}
      </Button>
      {open ? (
        <div className="fdy-chat-context-list" id={id}>
          {children}
        </div>
      ) : null}
    </>
  );
}

/** "12 finished", or "12 finished · 1 failed" so a failure is not lost. */
function finishedFoldLabel(finished: string, failed?: string): string {
  return failed ? `${finished} · ${failed}` : finished;
}

/**
 * Focuses a section's row when a new reveal request names it first, e.g. the
 * composer's "1 subagent running in the background" note.
 */
function useRevealedRow(
  reveal: { ids: string[] } | undefined,
): (id: string) => (element: HTMLButtonElement | null) => void {
  const rows = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => {
    const first = reveal?.ids[0];
    const row = first ? rows.current.get(first) : undefined;
    if (!row) return;
    row.focus();
    row.scrollIntoView?.({ block: "nearest" });
    // Only a new reveal request moves the focus.
  }, [reveal]);
  return (id) => (element) => {
    if (element) rows.current.set(id, element);
    else rows.current.delete(id);
  };
}

function BackgroundSection({
  chatKey,
  items,
  onSelect,
  reveal,
  selectedId,
}: {
  chatKey?: string;
  items: ChatBackgroundTaskItem[];
  onSelect?: (item: ChatContextSelection) => void;
  reveal?: { ids: string[] };
  selectedId?: string;
}) {
  const { t } = useTranslation("chat");
  const running = items.filter((item) => item.task.status === "running");
  const finished = items.filter((item) => item.task.status !== "running");
  const backgroundFailed = finished.filter(
    (item) => item.task.status === "failed",
  ).length;
  const now = useSharedNow(running.length > 0);
  const rowRef = useRevealedRow(reveal);
  const row = (item: ChatBackgroundTaskItem) => (
    <Button
      aria-pressed={selectedId === item.id}
      className="fdy-chat-context-row"
      data-selected={selectedId === item.id ? "true" : "false"}
      data-status={item.task.status}
      key={item.id}
      ref={rowRef(item.id)}
      onClick={() => onSelect?.(item)}
      title={item.label}
      variant="ghost"
    >
      <span className="fdy-chat-context-row-icon" data-kind="background">
        <BackgroundKindIcon kind={item.task.kind} />
      </span>
      <span className="fdy-chat-context-row-copy">
        <strong>{item.label}</strong>
        <em>{backgroundRowDetail(item, now)}</em>
      </span>
      <span className="fdy-chat-context-status">
        <BackgroundStatusIcon status={item.task.status} />
        {t(`contextCard.backgroundStatus.${item.task.status}`)}
      </span>
    </Button>
  );
  return (
    <section className="fdy-chat-context-section">
      <h3>
        {t("contextCard.background")}
        {running.length > 0 ? (
          <span className="fdy-chat-context-count">{running.length}</span>
        ) : null}
      </h3>
      <div className="fdy-chat-context-list">
        {running.map(row)}
        {finished.length > 0 ? (
          <FinishedFold
            label={finishedFoldLabel(
              t("contextCard.backgroundFinished", { count: finished.length }),
              backgroundFailed > 0
                ? t("contextCard.foldFailed", { count: backgroundFailed })
                : undefined,
            )}
            memoryKey={chatKey && `${chatKey}:background`}
          >
            {finished.map(row)}
          </FinishedFold>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Running subagents, then every one that ended (completed, failed, canceled)
 * folded, like background tasks; the fold names how many failed.
 */
function SubagentSection({
  chatKey,
  items,
  onRetry,
  onSelect,
  reveal,
  selectedId,
}: {
  chatKey?: string;
  items: ChatSubagentItem[];
  /** Refreshing the list failed: what is shown is the last list fetched. */
  onRetry?: () => void;
  onSelect?: (item: ChatContextSelection) => void;
  reveal?: { ids: string[] };
  selectedId?: string;
}) {
  const { t } = useTranslation(["chat", "common"]);
  const rowRef = useRevealedRow(reveal);
  // Avatar colors follow the full list, so a row keeps its color when it folds.
  const tones = new Map(items.map((item, index) => [item.id, (index % 3) + 1]));
  const running = items.filter((item) => item.status === "running");
  const finished = items.filter((item) => item.status !== "running");
  const failed = finished.filter((item) => item.status === "failed").length;
  const row = (subagent: ChatSubagentItem) => (
    <Button
      aria-pressed={selectedId === subagent.id}
      className="fdy-chat-context-row fdy-chat-subagent-row"
      data-status={subagent.status}
      data-selected={selectedId === subagent.id ? "true" : "false"}
      key={subagent.id}
      ref={rowRef(subagent.id)}
      onClick={() => onSelect?.(subagent)}
      title={subagent.detail ?? subagent.label}
      variant="ghost"
    >
      <span
        className="fdy-chat-subagent-avatar"
        data-tone={tones.get(subagent.id)}
      >
        <Bot aria-hidden="true" size={15} />
      </span>
      <span className="fdy-chat-context-row-copy">
        <strong>{subagent.label}</strong>
        {subagent.usage ? (
          <em>{subagentUsageSummary(subagent.usage)}</em>
        ) : null}
      </span>
      <span className="fdy-chat-context-status">
        <SubagentStatusIcon status={subagent.status} />
        {t(`contextCard.subagentStatus.${subagent.status}`)}
      </span>
    </Button>
  );
  return (
    <section className="fdy-chat-context-section">
      <h3>{t("contextCard.subagents")}</h3>
      {onRetry ? (
        <p className="fdy-chat-context-refresh-failed" role="status">
          {t("contextCard.subagentsRefreshFailed")}
          <Button onClick={onRetry} size="sm" variant="link">
            {t("common:actions.retry")}
          </Button>
        </p>
      ) : null}
      <div className="fdy-chat-context-list">
        {running.map(row)}
        {finished.length > 0 ? (
          <FinishedFold
            label={finishedFoldLabel(
              t("contextCard.subagentsFinished", { count: finished.length }),
              failed > 0
                ? t("contextCard.foldFailed", { count: failed })
                : undefined,
            )}
            memoryKey={chatKey && `${chatKey}:subagents`}
          >
            {finished.map(row)}
          </FinishedFold>
        ) : null}
      </div>
    </section>
  );
}

export const ChatContextCard = memo(function ChatContextCard({
  chatKey,
  data,
  onClearTurnFilter,
  onClose,
  onRetrySubagents,
  onSelect,
  reveal,
  selectedId,
  turnFilter,
}: {
  /** The open chat: which sections it unfolded is remembered by this key. */
  chatKey?: string;
  data: ChatContextCardData;
  onClearTurnFilter?: () => void;
  onClose?: () => void;
  /** Refreshing the subagents failed; offered as a retry beside them. */
  onRetrySubagents?: () => void;
  onSelect?: (item: ChatContextSelection) => void;
  /** Rows to open and focus: files an answer names, or running work. */
  reveal?: { ids: string[] };
  selectedId?: string;
  /** Shows only the files one turn (input) wrote or named. */
  turnFilter?: string;
}) {
  const { t } = useTranslation("chat");
  const [statusOpen, setStatusOpen] = useFoldOpen(
    chatKey && `${chatKey}:status`,
  );
  return (
    <aside
      className="fdy-chat-context-card"
      aria-label={t("contextCard.label")}
    >
      {onClose ? (
        <Button
          aria-label={t("contextCard.hide")}
          className="fdy-chat-context-close"
          onClick={onClose}
          size="icon"
          variant="ghost"
        >
          <X size={16} />
        </Button>
      ) : null}

      {data.status ? (
        <ChatSessionStatusLine
          onOpenChange={setStatusOpen}
          open={statusOpen}
          status={data.status}
        />
      ) : null}

      <SessionFileSections
        data={data}
        onClearTurnFilter={onClearTurnFilter}
        onSelect={onSelect}
        reveal={reveal}
        turnFilter={turnFilter}
      />

      {data.previews.length > 0 ? (
        <section className="fdy-chat-context-section">
          <h3>{t("contextCard.previews")}</h3>
          <div className="fdy-chat-context-list">
            {data.previews.map((item) => (
              <ResourceRow
                item={item}
                key={item.id}
                kind="preview"
                onSelect={onSelect}
                selected={selectedId === item.id}
              />
            ))}
          </div>
        </section>
      ) : null}

      {data.background.length > 0 ? (
        <BackgroundSection
          chatKey={chatKey}
          items={data.background}
          onSelect={onSelect}
          reveal={reveal}
          selectedId={selectedId}
        />
      ) : null}

      {data.timers.length > 0 ? (
        <section className="fdy-chat-context-section">
          <h3>{t("contextCard.timers")}</h3>
          <div className="fdy-chat-context-list">
            {data.timers.map((item) => (
              <TimerRow
                item={item}
                key={item.id}
                onSelect={onSelect}
                selected={selectedId === item.id}
              />
            ))}
          </div>
        </section>
      ) : null}

      {data.subagents.length > 0 ? (
        <SubagentSection
          chatKey={chatKey}
          items={data.subagents}
          onRetry={onRetrySubagents}
          onSelect={onSelect}
          reveal={reveal}
          selectedId={selectedId}
        />
      ) : null}

      {data.sources.length > 0 ? (
        <section className="fdy-chat-context-section">
          <h3>{t("contextCard.sources")}</h3>
          <div className="fdy-chat-context-list">
            {data.sources.map((item) => (
              <ResourceRow
                item={item}
                key={item.id}
                kind="source"
                onSelect={onSelect}
                selected={selectedId === item.id}
              />
            ))}
          </div>
        </section>
      ) : null}
    </aside>
  );
});
