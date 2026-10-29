import { useTranslation } from "react-i18next";
import { useSharedNow } from "../../lib/use-shared-now";
import { formatDuration } from "./turn-usage";

/**
 * Time since a running process group's first step (or its running tool
 * call's start), ticking once a second, against the call's limit when it
 * has one. The tick lives here, so only this text re-renders while a group
 * runs.
 */
export function ProcessElapsed({
  limitMs,
  startedAt,
}: {
  limitMs?: number;
  startedAt: string;
}) {
  const { t } = useTranslation("conversation");
  const started = Date.parse(startedAt);
  const now = useSharedNow(!Number.isNaN(started));
  if (Number.isNaN(started)) return null;
  const elapsed = formatDuration(Math.max(0, now - started));
  return (
    <span className="fdy-chat-process-trigger-meta">
      {limitMs
        ? t("process.elapsedLimit", { elapsed, limit: formatDuration(limitMs) })
        : elapsed}
    </span>
  );
}
