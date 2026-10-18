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
    <section aria-labelledby="fdy-pa-tasks-title" className="fdy-pa-tasks">
      <h2 className="fdy-pa-side-title" id="fdy-pa-tasks-title">
        {t("tasks.title")}
      </h2>
      {error ? (
        <Alert tone="error" title={t("tasks.loadFailed")}>
          {error}
        </Alert>
      ) : null}
      {active.length ? (
        <ul className="fdy-pa-task-list">
          {active.map((task) => (
            <TaskRow
              key={task.id}
              onStop={onStop}
              project={projectName(task.workspaceId)}
              task={task}
            />
          ))}
        </ul>
      ) : (
        <p className="fdy-pa-muted">{t("tasks.empty")}</p>
      )}
      {ended.length ? (
        <>
          <h3 className="fdy-pa-side-subtitle">{t("tasks.ended")}</h3>
          <ul className="fdy-pa-task-list">
            {ended.map((task) => (
              <TaskRow
                key={task.id}
                onStop={onStop}
                project={projectName(task.workspaceId)}
                task={task}
              />
            ))}
          </ul>
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
    <li className="fdy-pa-task" data-status={task.status}>
      <strong className="fdy-pa-task-title">{task.title}</strong>
      <span className="fdy-pa-task-meta">
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
      <span className="fdy-pa-task-meta fdy-pa-muted">
        {project ? <span>{t("tasks.where", { project })}</span> : null}
        <span title={fullWhen(task.createdAt)}>
          {t("tasks.started", { when: relativeWhen(task.createdAt) })}
        </span>
      </span>
      <span className="fdy-pa-task-actions">
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
        <Alert tone="error" title={t("tasks.stopFailed")}>
          {error}
        </Alert>
      ) : null}
    </li>
  );
}
