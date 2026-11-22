import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ChevronRight } from "lucide-react";
import type {
  PersonalAgentItem,
  PersonalAgentItemList,
  PersonalAgentTask,
} from "@bd777/foundry-protocol";
import { Alert } from "../../components/ui/alert";
import {
  ContextEmpty,
  ContextHeading,
  ContextHeadingAction,
  ContextList,
  ContextRow,
  ContextRowCopy,
  ContextSection,
} from "../../components/ui/context-card";
import { FinishedFold } from "../../components/finished-fold";
import { serverErrorText } from "../../lib/errors";
import { navigateToChat } from "../../lib/in-app-navigation";
import { relativeWhen } from "../../lib/time-format";
import { visibleTasks } from "./assistant-model";
import {
  AssistantMark,
  ClosedMark,
  helperStatusLabel,
  ItemLead,
  stateLabel,
} from "./items-marks";
import { itemMark, linkedSessionIds, type ItemMark } from "./items-model";

/** The rows the card shows; the rest sit behind 「全部」. */
const shownRows = 6;

export interface ItemsCardProps {
  /** Every open item, for the count and for the helpers they own. */
  open?: PersonalAgentItemList;
  openError: string;
  /** Items closed since the start of today. */
  closed: PersonalAgentItem[];
  /** The assistant's helpers; those of an item are shown on the item's row. */
  tasks: PersonalAgentTask[];
  projectName: (workspaceId: string) => string | undefined;
  onTick: (item: PersonalAgentItem, done: boolean) => Promise<void>;
  onOpenAll: () => void;
  onOpenItem: (itemId: string) => void;
}

/**
 * 「事项」: what the person wants done or plans, and the assistant's work on
 * it, in one list. Each open item is one row whose secondary line says who
 * has it and what is going on; items closed today and helpers without an
 * item fold away. The whole list is on the items page.
 */
export function ItemsCard({
  open,
  openError,
  closed,
  tasks,
  projectName,
  onTick,
  onOpenAll,
  onOpenItem,
}: ItemsCardProps) {
  const { t } = useTranslation("personalAgent");
  const [busyId, setBusyId] = useState("");
  const [tickError, setTickError] = useState("");
  const openItems = open?.items ?? [];
  const openCount = open?.total ?? 0;
  const linked = linkedSessionIds([...openItems, ...closed]);
  const others = visibleTasks(
    tasks.filter((task) => !linked.has(task.sessionId ?? "")),
  );

  const tick = async (item: PersonalAgentItem) => {
    setBusyId(item.id);
    setTickError("");
    try {
      await onTick(item, true);
    } catch (reason) {
      setTickError(serverErrorText(reason));
    } finally {
      setBusyId("");
    }
  };

  const all = (
    <ContextHeadingAction
      label={t("items.card.allLabel", { count: openCount })}
      onClick={onOpenAll}
    >
      {t("items.card.all")}
    </ContextHeadingAction>
  );

  return (
    <ContextSection aria-label={t("items.card.label")}>
      <ContextHeading action={all} count={openCount}>
        {t("items.card.title")}
      </ContextHeading>
      {openError ? (
        <Alert
          className="mb-2.5"
          size="compact"
          title={t("items.card.loadFailed")}
          tone="error"
        >
          {openError}
        </Alert>
      ) : null}
      {tickError ? (
        <Alert
          className="mb-2.5"
          size="compact"
          title={t("items.card.tickFailed")}
          tone="error"
        >
          {tickError}
        </Alert>
      ) : null}
      {openCount === 0 && !openError ? (
        <ContextEmpty>{t("items.card.empty")}</ContextEmpty>
      ) : null}
      {openItems.length ? (
        <ContextList className="gap-1">
          {openItems.slice(0, shownRows).map((item) => (
            <ItemRow
              busy={busyId === item.id}
              item={item}
              key={item.id}
              onOpen={onOpenItem}
              onTick={tick}
            />
          ))}
        </ContextList>
      ) : null}
      {others.active.length ? (
        <ContextList className="gap-1">
          {others.active.map((task) => (
            <TaskRow
              key={task.id}
              projectName={projectName(task.workspaceId)}
              task={task}
            />
          ))}
        </ContextList>
      ) : null}
      {others.ended.length ? (
        <FinishedFold
          label={t("items.card.otherEnded", { count: others.ended.length })}
          memoryKey="assistant-items-other-ended"
        >
          <ContextList className="gap-1">
            {others.ended.map((task) => (
              <TaskRow
                key={task.id}
                projectName={projectName(task.workspaceId)}
                task={task}
              />
            ))}
          </ContextList>
        </FinishedFold>
      ) : null}
      {closed.length ? (
        <FinishedFold
          label={t("items.card.ended", { count: closed.length })}
          memoryKey="assistant-items-ended"
        >
          <ContextList className="gap-1">
            {closed.map((item) => (
              <ClosedRow item={item} key={item.id} onOpen={onOpenItem} />
            ))}
          </ContextList>
        </FinishedFold>
      ) : null}
    </ContextSection>
  );
}

/** The row's second line: who has the item and what is going on, in words. */
function detailLine(
  item: PersonalAgentItem,
  mark: ItemMark,
  t: TFunction<"personalAgent">,
): string {
  const origin = item.origin;
  if (origin?.kind === "channel" && origin.requester)
    return t("items.card.fromChannel", {
      source: origin.name || origin.source || "",
      requester: origin.requester,
    });
  if (mark.kind === "person")
    return item.when
      ? t("items.card.youWhen", { when: item.when })
      : t("items.card.you");
  const when = relativeWhen(item.updatedAt);
  if (mark.state === "idle") return t("items.card.assistantIdle", { when });
  const helper =
    mark.helper?.title || mark.helper?.project || t("items.helper.unnamed");
  return t(
    mark.state === "asking"
      ? "items.card.assistantAsking"
      : "items.card.assistantRunning",
    { helper, when },
  );
}

function ItemRow({
  busy,
  item,
  onOpen,
  onTick,
}: {
  busy: boolean;
  item: PersonalAgentItem;
  onOpen: (itemId: string) => void;
  onTick: (item: PersonalAgentItem) => Promise<void>;
}) {
  const { t } = useTranslation("personalAgent");
  return (
    <div className="flex min-w-0 items-center gap-1">
      <ItemLead
        busy={busy}
        item={item}
        onTick={(ticked) => void onTick(ticked)}
      />
      <ContextRow
        className="min-w-0 flex-1"
        onClick={() => onOpen(item.id)}
        title={item.text}
      >
        <ContextRowCopy
          detail={detailLine(item, itemMark(item), t)}
          title={item.text}
        />
        <ChevronRight
          aria-hidden="true"
          className="flex-none text-ink-faint"
          size={14}
        />
      </ContextRow>
    </div>
  );
}

function ClosedRow({
  item,
  onOpen,
}: {
  item: PersonalAgentItem;
  onOpen: (itemId: string) => void;
}) {
  const { t } = useTranslation("personalAgent");
  return (
    <div className="flex min-w-0 items-center gap-1">
      <span className="flex w-7 flex-none justify-center">
        <ClosedMark done={item.status === "done"} />
      </span>
      <ContextRow
        className="min-w-0 flex-1"
        onClick={() => onOpen(item.id)}
        title={item.text}
      >
        <ContextRowCopy
          detail={`${stateLabel(item, t)} · ${relativeWhen(item.closedAt)}`}
          title={item.text}
        />
      </ContextRow>
    </div>
  );
}

function TaskRow({
  projectName,
  task,
}: {
  projectName?: string;
  task: PersonalAgentTask;
}) {
  const { t } = useTranslation("personalAgent");
  const detail = [
    projectName ? t("items.card.taskWhere", { project: projectName }) : "",
    task.waitingFor
      ? t("items.card.waitingForComputer", { computer: task.waitingFor })
      : helperStatusLabel(task.status, t),
  ]
    .filter(Boolean)
    .join(" · ");
  const ended =
    task.status === "done" ||
    task.status === "failed" ||
    task.status === "cancelled";
  return (
    <div className="flex min-w-0 items-center gap-1">
      <span className="flex w-7 flex-none justify-center">
        {ended ? (
          <ClosedMark done={task.status === "done"} />
        ) : (
          <AssistantMark
            state={
              task.status === "asking"
                ? "asking"
                : task.status === "running"
                  ? "running"
                  : "idle"
            }
          />
        )}
      </span>
      <ContextRow
        className="min-w-0 flex-1"
        disabled={!task.sessionId}
        onClick={() => {
          if (task.sessionId) navigateToChat(task.sessionId, task.workspaceId);
        }}
        title={task.title}
      >
        <ContextRowCopy detail={detail} title={task.title} />
        {task.sessionId ? (
          <ChevronRight
            aria-hidden="true"
            className="flex-none text-ink-faint"
            size={14}
          />
        ) : null}
      </ContextRow>
    </div>
  );
}
