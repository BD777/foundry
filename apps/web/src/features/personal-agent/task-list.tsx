import { ToastFeedback } from "../../components/ui/toast";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, OctagonX } from "lucide-react";
import type { PersonalAgentTask } from "@bd777/foundry-protocol";
import { Alert } from "../../components/ui/alert";
import { Badge, type BadgeProps } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { serverErrorText } from "../../lib/errors";
import { navigateToChat } from "../../lib/in-app-navigation";
import { fullWhen, relativeWhen } from "../../lib/time-format";
import { isTaskActive, visibleTasks } from "./assistant-model";
import { PaMuted } from "./pa-muted";
import { Subheading } from "../../components/ui/subheading";
import { DividedList } from "../../components/ui/divided-list";

const statusTone: Record<
  PersonalAgentTask["status"],
  NonNullable<BadgeProps["tone"]>
> = {
  queued: "slate",
  running: "online",
  asking: "brass",
  done: "neutral",
  failed: "error",
  cancelled: "neutral",
};

/**
 * "What I'm doing": the work the assistant handed off and follows up, each
 * stoppable on its own and openable to watch its progress.
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
  return (
    <section aria-labelledby="fdy-pa-tasks-title" className="grid gap-2.5">
      <Subheading as="h2" id="fdy-pa-tasks-title">
        {t("tasks.title")}
      </Subheading>
      {error ? (
        <Alert tone="error" title={t("tasks.loadFailed")}>
          {error}
        </Alert>
      ) : null}
      {active.length ? (
        <DividedList density="none">
          {active.map((task) => (
            <TaskRow
              key={task.id}
              onStop={onStop}
              project={projectName(task.workspaceId)}
              task={task}
            />
          ))}
        </DividedList>
      ) : (
        <PaMuted>{t("tasks.empty")}</PaMuted>
      )}
      {ended.length ? (
        <>
          <Subheading className="mt-2" size="caption">
            {t("tasks.ended")}
          </Subheading>
          <DividedList density="none">
            {ended.map((task) => (
              <TaskRow
                key={task.id}
                onStop={onStop}
                project={projectName(task.workspaceId)}
                task={task}
              />
            ))}
          </DividedList>
        </>
      ) : null}
    </section>
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

  return (
    <li className="grid gap-1.5 py-2.5" data-status={task.status}>
      <strong className="text-sm leading-[1.45] wrap-anywhere text-ink">
        {task.title}
      </strong>
      <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        {task.waitingFor ? (
          <Badge tone="warn">
            {t("tasks.waitingForComputer", { computer: task.waitingFor })}
          </Badge>
        ) : (
          <Badge tone={statusTone[task.status]}>
            {t(`tasks.status.${task.status}`)}
          </Badge>
        )}
        {task.stuckSince && active ? (
          <Badge tone="warn">{t("tasks.stuck")}</Badge>
        ) : null}
      </span>
      <PaMuted
        as="span"
        className="flex flex-wrap items-center gap-x-2.5 gap-y-1"
      >
        {project ? <span>{t("tasks.where", { project })}</span> : null}
        <span title={fullWhen(task.createdAt)}>
          {t("tasks.started", { when: relativeWhen(task.createdAt) })}
        </span>
      </PaMuted>
      <span className="flex flex-wrap gap-1.5">
        {task.sessionId ? (
          <Button
            onClick={() => navigateToChat(task.sessionId!, task.workspaceId)}
            size="sm"
            variant="ghost"
          >
            {t("tasks.open")}
            <ArrowRight aria-hidden="true" size={14} />
          </Button>
        ) : null}
        {active ? (
          <Button
            aria-busy={stopping}
            disabled={stopping}
            onClick={() => void stop()}
            size="sm"
            variant="secondary"
          >
            <OctagonX aria-hidden="true" size={14} />
            {stopping ? t("tasks.stopping") : t("tasks.stop")}
          </Button>
        ) : null}
      </span>
      {error ? (
        <ToastFeedback tone="error" title={t("tasks.stopFailed")}>
          {error}
        </ToastFeedback>
      ) : null}
    </li>
  );
}
