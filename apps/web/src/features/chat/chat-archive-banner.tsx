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
    <Alert title={t("archive.title")} aria-label={t("archive.title")}>
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
        })}
      </p>
      <Button
        disabled={busy || readOnly}
        onClick={() => void onUnarchive().catch(() => {})}
      >
        {t("archive.unarchive")}
      </Button>
      <ul>
        {chat.nativeArchive?.map((target) => (
          <li
            key={`${target.provider}:${target.deviceId}:${target.nativeSessionId}`}
          >
            {target.provider} · {target.deviceLabel || target.deviceId}:{" "}
            {t(`archive.native.${target.state}`)}
            {target.error ? ` · ${target.error}` : ""}
            {target.state === "failed" ? (
              <Button
                variant="link"
                disabled={busy || readOnly || retrying}
                onClick={() => void retry()}
              >
                {t("archive.retry")}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {error ? (
        <ToastFeedback tone="error" title={t("archive.failed")}>
          {error}
        </ToastFeedback>
      ) : null}
    </Alert>
  );
}
