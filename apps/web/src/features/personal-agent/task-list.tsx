import { ToastFeedback } from "../../components/ui/toast";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Bot,
  Check,
  CircleX,
  Clock,
  LoaderCircle,
  MessageCircleQuestion,
  OctagonX,
} from "lucide-react";
import type { PersonalAgentTask } from "@bd777/foundry-protocol";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import {
  ContextEmpty,
  ContextHeading,
  ContextList,
  ContextRow,
  ContextRowCopy,
  ContextRowIcon,
  ContextSection,
  ContextStaticRow,
  ContextStatus,
} from "../../components/ui/context-card";
import { Subheading } from "../../components/ui/subheading";
import { serverErrorText } from "../../lib/errors";
import { navigateToChat } from "../../lib/in-app-navigation";
import { fullWhen, relativeWhen } from "../../lib/time-format";
import { isTaskActive, visibleTasks } from "./assistant-model";

const statusIcon: Record<PersonalAgentTask["status"], typeof Bot> = {
  queued: Clock,
  running: LoaderCircle,
  asking: MessageCircleQuestion,
  done: Check,
  failed: CircleX,
  cancelled: OctagonX,
};

/**
 * "What I'm doing": the work the assistant handed off and follows up, each
 * openable to watch its progress and stoppable on its own.
 */
export function TaskList({
  tasks,
  error,
  projectName,
  onStop,
}: {
  tasks: PersonalAgentTask[];
  error: string;
  /** A project's name, by id. */
  projectName: (workspaceId: string) => string | undefined;
  onStop: (task: PersonalAgentTask) => Promise<void>;
}) {
  const { t } = useTranslation("personalAgent");
  const { active, ended } = visibleTasks(tasks);
  if (!active.length && !ended.length && !error)
    return (
      <ContextSection aria-label={t("tasks.title")} className="py-3.5">
        <ContextHeading
          action={<ContextEmpty>{t("tasks.empty")}</ContextEmpty>}
          className="mb-0"
        >
          {t("tasks.title")}
        </ContextHeading>
      </ContextSection>
    );
  const row = (task: PersonalAgentTask) => (
    <TaskRow
      key={task.id}
      onStop={onStop}
      project={projectName(task.workspaceId)}
      task={task}
    />
  );
  return (
    <ContextSection aria-label={t("tasks.title")}>
      <ContextHeading count={active.length}>{t("tasks.title")}</ContextHeading>
      {error ? (
        <Alert
          className="mb-2.5"
          size="compact"
          title={t("tasks.loadFailed")}
          tone="error"
        >
          {error}
        </Alert>
      ) : null}
      {active.length ? (
        <ContextList className="gap-1">{active.map(row)}</ContextList>
      ) : null}
      {ended.length ? (
        <>
          <Subheading
            className={active.length ? "mt-3 mb-1.5" : "mb-1.5"}
            size="caption"
          >
            {t("tasks.ended")}
          </Subheading>
          <ContextList className="gap-1">{ended.map(row)}</ContextList>
        </>
      ) : null}
    </ContextSection>
  );
}

function TaskRow({
  task,
  project,
  onStop,
}: {
  task: PersonalAgentTask;
  project: string | undefined;
  onStop: (task: PersonalAgentTask) => Promise<void>;
}) {
  const { t } = useTranslation("personalAgent");
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const active = isTaskActive(task);
  const StatusIcon = statusIcon[task.status];

  async function stop(): Promise<void> {
    setStopping(true);
    setError("");
    try {
      await onStop(task);
    } catch (reason) {
      setError(serverErrorText(reason));
    } finally {
      setStopping(false);
    }
  }

  const detail = [
    project ? t("tasks.where", { project }) : "",
    t("tasks.started", { when: relativeWhen(task.createdAt) }),
  ]
    .filter(Boolean)
    .join(" · ");
  const status = task.waitingFor
    ? t("tasks.waitingForComputer", { computer: task.waitingFor })
    : task.stuckSince && active
      ? t("tasks.stuck")
      : t(`tasks.status.${task.status}`);
  const content = (
    <>
      <ContextRowIcon>
        <Bot aria-hidden="true" size={15} />
      </ContextRowIcon>
      <ContextRowCopy detail={detail} title={task.title} />
      <ContextStatus
        tone={
          task.status === "failed" || (task.stuckSince && active)
            ? "failed"
            : task.status === "running" && !task.waitingFor
              ? "running"
              : "default"
        }
      >
        <StatusIcon aria-hidden="true" size={13} />
        {status}
      </ContextStatus>
    </>
  );
  const title = `${task.title}\n${fullWhen(task.createdAt)}`;
  return (
    <div className="grid min-w-0 gap-1" data-status={task.status}>
      <div className="flex min-w-0 items-center gap-1">
        {task.sessionId ? (
          <ContextRow
            aria-label={`${t("tasks.open")}: ${task.title}`}
            className="min-w-0 flex-1"
            onClick={() => navigateToChat(task.sessionId!, task.workspaceId)}
            title={title}
          >
            {content}
          </ContextRow>
        ) : (
          <ContextStaticRow className="min-w-0 flex-1" title={title}>
            {content}
          </ContextStaticRow>
        )}
        {active ? (
          <Button
            aria-busy={stopping}
            aria-label={`${stopping ? t("tasks.stopping") : t("tasks.stop")}: ${task.title}`}
            className="size-7 flex-none text-ink-muted"
            disabled={stopping}
            onClick={() => void stop()}
            size="icon"
            title={t("tasks.stop")}
            variant="ghost"
          >
            <OctagonX aria-hidden="true" size={15} />
          </Button>
        ) : null}
      </div>
      {error ? (
        <ToastFeedback tone="error" title={t("tasks.stopFailed")}>
          {error}
        </ToastFeedback>
      ) : null}
    </div>
  );
}
