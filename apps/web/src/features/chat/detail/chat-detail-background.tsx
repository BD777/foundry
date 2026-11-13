import { ToastFeedback } from "../../../components/ui/toast";
import { useEffect, useState } from "react";
import { CircleStop } from "lucide-react";
import { useTranslation } from "react-i18next";
import { stopBackgroundTask } from "../../../api";
import { Alert } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { formatDuration } from "../../../components/conversation/turn-usage";
import { useSharedNow } from "../../../lib/use-shared-now";
import { BackgroundStatusIcon } from "../context/chat-context-background";
import { formatFileSize } from "./chat-detail-files";
import { formatTimerDateTime } from "./chat-detail-timer";
import { useBackgroundTaskOutput } from "./use-background-task-output";
import type { ChatBackgroundTaskItem } from "../chat-types";
import { ContextStatus } from "../../../components/ui/context-card";
import {
  MetaDetail,
  MetaHeading,
  MetaList,
  MetaNote,
  MetaPre,
  MetaRow,
} from "./chat-detail-parts";
import { LoadingState } from "../../../components/ui/loading";

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
    <MetaDetail>
      <MetaList>
        <MetaRow label={t("detail.background.kind")}>
          {t(`contextCard.backgroundKind.${task.kind}`)}
        </MetaRow>
        {item.ownerLabel ? (
          <MetaRow label={t("detail.background.startedBy")}>
            {item.ownerLabel}
          </MetaRow>
        ) : null}
        <MetaRow label={t("detail.background.started")}>
          {formatTimerDateTime(task.startedAt)}
        </MetaRow>
        <MetaRow label={t("detail.background.duration")}>{duration}</MetaRow>
        {task.timeLimitMs ? (
          <MetaRow label={t("detail.background.timeLimit")}>
            {formatDuration(task.timeLimitMs)}
          </MetaRow>
        ) : null}
        <MetaRow label={t("detail.background.status")}>
          <ContextStatus>
            <BackgroundStatusIcon status={task.status} />
            {t(`contextCard.backgroundStatus.${task.status}`)}
          </ContextStatus>
          {task.stopReason ? (
            <> · {t(`detail.background.stopReason.${task.stopReason}`)}</>
          ) : null}
        </MetaRow>
        {task.exitCode !== undefined ? (
          <MetaRow label={t("detail.background.exitCode")}>
            <code>{task.exitCode}</code>
          </MetaRow>
        ) : null}
      </MetaList>
      {task.summary ? (
        <>
          <MetaHeading>{t("detail.background.summary")}</MetaHeading>
          <MetaNote>{task.summary}</MetaNote>
        </>
      ) : null}
      {running && canControl ? (
        <div className="flex flex-wrap items-center gap-2 [&_p]:basis-full [&_p]:text-xs [&_p]:leading-[1.45] [&_p]:text-ink-muted">
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
            <ToastFeedback
              tone="error"
              title={t("detail.background.stopFailed")}
            >
              {stopError}
            </ToastFeedback>
          ) : null}
        </div>
      ) : null}
      {membersOnly ? (
        <Alert size="compact" title={t("detail.background.membersOnly")} />
      ) : (
        <>
          {output?.command ? (
            <>
              <MetaHeading>{t("detail.background.command")}</MetaHeading>
              <MetaPre>{output.command}</MetaPre>
            </>
          ) : null}
          <MetaHeading>
            {t("detail.background.output")}
            {running ? (
              <small>{t("detail.background.outputLive")}</small>
            ) : null}
          </MetaHeading>
          {outputError ? (
            <Alert size="compact" title={outputError} tone="error" />
          ) : !output ? (
            <LoadingState label={t("common:states.loading")} layout="block" />
          ) : output.kind === "missing" ? (
            <Alert
              size="compact"
              title={
                running
                  ? t("detail.background.outputEmpty")
                  : t("detail.background.outputMissing")
              }
            />
          ) : output.kind === "binary" ? (
            <Alert
              size="compact"
              title={t("detail.background.outputBinary", {
                size: formatFileSize(output.bytes),
              })}
            />
          ) : output.content ? (
            <>
              {output.truncated ? (
                <Alert
                  size="compact"
                  title={t("detail.background.outputTail", {
                    size: formatFileSize(64 * 1024),
                  })}
                />
              ) : null}
              <MetaPre className="max-h-[min(60vh,520px)]">
                {output.content}
              </MetaPre>
            </>
          ) : (
            <Alert size="compact" title={t("detail.background.outputEmpty")} />
          )}
        </>
      )}
    </MetaDetail>
  );
}
