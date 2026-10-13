import { useEffect, useState } from "react";
import { CircleStop, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { stopBackgroundTask } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { formatDuration } from "../../components/conversation/turn-usage";
import { useSharedNow } from "../../lib/use-shared-now";
import { BackgroundStatusIcon } from "./chat-context-background";
import { formatFileSize } from "./chat-detail-files";
import { formatTimerDateTime } from "./chat-detail-timer";
import { useBackgroundTaskOutput } from "./use-background-task-output";
import type { ChatBackgroundTaskItem } from "./chat-types";

/**
 * One background task: what it is, how long it ran and how it ended; for
 * members, its redacted command and the end of its output, refreshed while
 * it runs, and a way to stop it.
 */
export function BackgroundTaskDetail({
  canControl,
  item,
}: {
  canControl: boolean;
  item: ChatBackgroundTaskItem;
}) {
  const { t } = useTranslation(["chat", "common"]);
  const task = item.task;
  const running = task.status === "running";
  const now = useSharedNow(running);
  const {
    output,
    error: outputError,
    membersOnly,
  } = useBackgroundTaskOutput(item.sessionId, task.id, running);
  const [confirming, setConfirming] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string>();

  useEffect(() => {
    setConfirming(false);
    setStopping(false);
    setStopError(undefined);
  }, [item.id]);

  useEffect(() => {
    if (!running) setStopping(false);
  }, [running]);

  const stop = async () => {
    setStopping(true);
    setStopError(undefined);
    try {
      await stopBackgroundTask(item.sessionId, task.id);
      setConfirming(false);
    } catch (reason) {
      setStopping(false);
      setStopError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const started = new Date(task.startedAt);
  const duration = formatDuration(
    Math.max(
      0,
      (task.endedAt ? Date.parse(task.endedAt) : now) - started.getTime(),
    ),
  );
  return (
    <article className="fdy-chat-meta-detail">
      <dl className="fdy-chat-meta-list">
        <div>
          <dt>{t("detail.background.kind")}</dt>
          <dd>{t(`contextCard.backgroundKind.${task.kind}`)}</dd>
        </div>
        {item.ownerLabel ? (
          <div>
            <dt>{t("detail.background.startedBy")}</dt>
            <dd>{item.ownerLabel}</dd>
          </div>
        ) : null}
        <div>
          <dt>{t("detail.background.started")}</dt>
          <dd>{formatTimerDateTime(task.startedAt)}</dd>
        </div>
        <div>
          <dt>{t("detail.background.duration")}</dt>
          <dd>{duration}</dd>
        </div>
        {task.timeLimitMs ? (
          <div>
            <dt>{t("detail.background.timeLimit")}</dt>
            <dd>{formatDuration(task.timeLimitMs)}</dd>
          </div>
        ) : null}
        <div>
          <dt>{t("detail.background.status")}</dt>
          <dd>
            <span className="fdy-chat-context-status">
              <BackgroundStatusIcon status={task.status} />
              {t(`contextCard.backgroundStatus.${task.status}`)}
            </span>
            {task.stopReason ? (
              <> · {t(`detail.background.stopReason.${task.stopReason}`)}</>
            ) : null}
          </dd>
        </div>
        {task.exitCode !== undefined ? (
          <div>
            <dt>{t("detail.background.exitCode")}</dt>
            <dd>
              <code>{task.exitCode}</code>
            </dd>
          </div>
        ) : null}
      </dl>
      {task.summary ? (
        <>
          <h4>{t("detail.background.summary")}</h4>
          <p className="fdy-chat-meta-note">{task.summary}</p>
        </>
      ) : null}
      {running && canControl ? (
        <div className="fdy-chat-background-actions">
          {confirming ? (
            <>
              <p role="status">{t("detail.background.stopConfirm")}</p>
              <Button
                disabled={stopping}
                onClick={() => void stop()}
                size="sm"
                variant="primary"
              >
                {stopping
                  ? t("detail.background.stopping")
                  : t("detail.background.stopConfirmAction")}
              </Button>
              <Button
                disabled={stopping}
                onClick={() => setConfirming(false)}
                size="sm"
                variant="ghost"
              >
                {t("detail.background.keepRunning")}
              </Button>
            </>
          ) : (
            <Button
              onClick={() => setConfirming(true)}
              size="sm"
              variant="secondary"
            >
              <CircleStop aria-hidden="true" size={14} />
              {t("detail.background.stop")}
            </Button>
          )}
          {stopError ? (
            <Alert tone="error" title={t("detail.background.stopFailed")}>
              {stopError}
            </Alert>
          ) : null}
        </div>
      ) : null}
      {membersOnly ? (
        <p className="fdy-chat-meta-note">
          {t("detail.background.membersOnly")}
        </p>
      ) : (
        <>
          {output?.command ? (
            <>
              <h4>{t("detail.background.command")}</h4>
              <pre className="fdy-chat-meta-pre">{output.command}</pre>
            </>
          ) : null}
          <h4>
            {t("detail.background.output")}
            {running ? (
              <small>{t("detail.background.outputLive")}</small>
            ) : null}
          </h4>
          {outputError ? (
            <div className="fdy-chat-detail-error">{outputError}</div>
          ) : !output ? (
            <div className="fdy-chat-detail-loading">
              <LoaderCircle aria-hidden="true" size={18} />
              {t("common:states.loading")}
            </div>
          ) : output.kind === "missing" ? (
            <p className="fdy-chat-meta-note">
              {running
                ? t("detail.background.outputEmpty")
                : t("detail.background.outputMissing")}
            </p>
          ) : output.kind === "binary" ? (
            <p className="fdy-chat-meta-note">
              {t("detail.background.outputBinary", {
                size: formatFileSize(output.bytes),
              })}
            </p>
          ) : output.content ? (
            <>
              {output.truncated ? (
                <p className="fdy-chat-meta-note">
                  {t("detail.background.outputTail", {
                    size: formatFileSize(64 * 1024),
                  })}
                </p>
              ) : null}
              <pre className="fdy-chat-meta-pre fdy-chat-background-output">
                {output.content}
              </pre>
            </>
          ) : (
            <p className="fdy-chat-meta-note">
              {t("detail.background.outputEmpty")}
            </p>
          )}
        </>
      )}
    </article>
  );
}
