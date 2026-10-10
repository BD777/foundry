import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import type { TranscriptLoadState } from "./chat-transcript-loader";

function loadedSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

/**
 * The top of a transcript: how its loading goes (with a retry once it is
 * slow or failed) and the way to older messages.
 */
export function ChatTranscriptHistory({
  onLoadEarlier,
  onRetry,
  state,
}: {
  onLoadEarlier: () => void;
  onRetry: () => void;
  state: TranscriptLoadState;
}) {
  const { t } = useTranslation(["chat", "common"]);
  const hasEarlier = Object.keys(state.earlier).length > 0;
  if (!state.loading && !state.failed && !hasEarlier && !state.earlierFailed)
    return null;
  const progress = state.progress
    ? state.progress.totalBytes
      ? `${Math.min(99, Math.round((state.progress.loadedBytes / state.progress.totalBytes) * 100))}%`
      : loadedSize(state.progress.loadedBytes)
    : "";
  const status =
    state.loading || state.failed
      ? state.slow
        ? t("chat:history.slow")
        : state.failed
          ? t("chat:history.failed")
          : t("chat:history.loading")
      : state.earlierFailed
        ? t("chat:history.earlierFailed")
        : "";
  return (
    <div
      className="fdy-chat-history"
      aria-live="polite"
      data-state={state.failed || state.earlierFailed ? "error" : "loading"}
    >
      {status ? (
        <span className="fdy-chat-history-status">
          {state.loading ? (
            <span className="fdy-chat-history-spinner" aria-hidden="true" />
          ) : null}
          {status}
          {state.loading && progress ? (
            <span className="fdy-chat-history-progress">{progress}</span>
          ) : null}
        </span>
      ) : null}
      {state.slow || state.failed ? (
        <Button onClick={onRetry} size="sm" variant="secondary">
          {t("common:actions.retry")}
        </Button>
      ) : null}
      {!state.loading && (hasEarlier || state.earlierFailed) ? (
        <Button
          aria-busy={state.loadingEarlier}
          disabled={state.loadingEarlier || !hasEarlier}
          onClick={onLoadEarlier}
          size="sm"
          variant="secondary"
        >
          {state.loadingEarlier
            ? t("chat:history.loadingEarlier")
            : state.earlierFailed
              ? t("common:actions.retry")
              : t("chat:history.loadEarlier")}
        </Button>
      ) : null}
    </div>
  );
}
