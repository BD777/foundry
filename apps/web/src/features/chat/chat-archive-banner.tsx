import { Alert } from "../../components/ui/alert";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AgentSession, ChatThread } from "@bd777/foundry-protocol";
import { retryNativeArchive } from "../../api";
import { ToastFeedback } from "../../components/ui/toast";
import { Button } from "../../components/ui/button";

export type ArchivedChat = Pick<
  ChatThread,
  | "id"
  | "title"
  | "provider"
  | "archivedAt"
  | "archivedByLabel"
  | "archivedByUser"
  | "archivedBySession"
  | "nativeArchive"
> & { deviceId?: string; preview?: string };

/**
 * Shown in place of the composer of an archived chat: who archived it and
 * when, and how to continue it.
 */
export function ChatArchiveBanner({
  chat,
  workspaceId,
  busy,
  readOnly,
  onUnarchive,
  onRefresh,
}: {
  chat: ArchivedChat | AgentSession;
  workspaceId: string;
  busy: boolean;
  readOnly?: boolean;
  onUnarchive: () => Promise<unknown>;
  onRefresh: () => Promise<unknown>;
}) {
  const { t, i18n } = useTranslation("chat");
  const [error, setError] = useState("");
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    setRetrying(true);
    setError("");
    try {
      await retryNativeArchive(chat.id, workspaceId);
      await onRefresh();
    } catch (error) {
      setError(String(error instanceof Error ? error.message : error));
    } finally {
      setRetrying(false);
    }
  };
  return (
    <Alert
      title={t("archive.chatArchived")}
      aria-label={t("archive.chatArchived")}
    >
      <p>
        {t("archive.banner", {
          date: chat.archivedAt
            ? new Date(chat.archivedAt).toLocaleString(
                i18n.resolvedLanguage || i18n.language,
              )
            : t("archive.unknownDate"),
          who:
            chat.archivedByLabel ||
            (chat.archivedBySession ? t("archive.agentActor") : "") ||
            t("archive.unknownActor"),
        })}{" "}
        {t("archive.continue")}
      </p>
      <ul>
        {chat.nativeArchive?.map((target) => (
          <li
            key={`${target.provider}:${target.deviceId}:${target.nativeSessionId}`}
          >
            {target.provider} · {target.deviceLabel || target.deviceId}:{" "}
            {t(`archive.native.${target.state}`)}
            {target.error ? ` · ${target.error}` : ""}
            {target.state === "failed" ? (
              <>
                {" "}
                <Button
                  size="inline"
                  variant="link"
                  disabled={busy || readOnly || retrying}
                  onClick={() => void retry()}
                >
                  {t("archive.retry")}
                </Button>
              </>
            ) : null}
          </li>
        ))}
      </ul>
      <Button
        className="fdy-chat-thread-notice-action"
        disabled={busy || readOnly}
        onClick={() => void onUnarchive().catch(() => {})}
        size="sm"
        variant="secondary"
      >
        {t("archive.unarchive")}
      </Button>
      {error ? (
        <ToastFeedback tone="error" title={t("archive.failed")}>
          {error}
        </ToastFeedback>
      ) : null}
    </Alert>
  );
}
