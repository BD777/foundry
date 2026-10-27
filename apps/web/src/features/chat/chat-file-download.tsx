import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { useTranslation } from "react-i18next";
import { apiBaseUrl } from "../../lib/api-base-url";
import { apiErrorOf, apiFetch } from "../../api/http";
import { Button } from "../../components/ui/button";
import { FileReadFeedback } from "./chat-file-read-feedback";
import {
  readResponseBlob,
  type ReadProgress,
} from "../../lib/read-response-blob";
import { formatBytes } from "../../lib/format";
import { requestDeviceFile } from "./device-file-request";

export function ChatFileDownload({
  path,
  workspaceId,
  sessionId,
}: {
  path: string;
  workspaceId?: string;
  sessionId?: string;
}) {
  const { t } = useTranslation("chat");
  const [busy, setBusy] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<unknown>();
  const [progress, setProgress] = useState<ReadProgress>({ received: 0 });
  const active = useRef<AbortController | undefined>(undefined);
  const url = useRef<string | undefined>(undefined);
  const revokeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => {
    setBusy(false);
    setError(undefined);
    setRetrying(false);
    active.current = undefined;
    return () => {
      active.current?.abort();
      clearTimeout(revokeTimer.current);
      if (url.current) URL.revokeObjectURL(url.current);
      url.current = undefined;
    };
  }, [path, workspaceId, sessionId]);

  const download = async () => {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setProgress({ received: 0 });
    setRetrying(false);
    setError(undefined);
    const params = new URLSearchParams({ path });
    if (!sessionId) params.set("workspaceId", workspaceId ?? "");
    const endpoint = sessionId
      ? `/api/agent-sessions/${encodeURIComponent(sessionId)}/files/download`
      : "/api/workspace-files/download";
    try {
      const blob = await requestDeviceFile(
        async () => {
          setProgress({ received: 0 });
          const response = await apiFetch(
            `${apiBaseUrl}${endpoint}?${params}`,
            { signal: controller.signal, cache: "no-store" },
          );
          if (!response.ok)
            throw apiErrorOf(await response.text(), endpoint, response.status);
          return readResponseBlob(response, controller.signal, setProgress);
        },
        controller.signal,
        () => setRetrying(true),
      );
      if (controller.signal.aborted) return;
      if (url.current) URL.revokeObjectURL(url.current);
      clearTimeout(revokeTimer.current);
      url.current = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url.current;
      link.download = path.split(/[\\/]/).pop() || "download";
      document.body.append(link);
      link.click();
      link.remove();
      revokeTimer.current = setTimeout(() => {
        if (url.current) URL.revokeObjectURL(url.current);
        url.current = undefined;
      }, 60000);
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason);
    } finally {
      if (active.current === controller) active.current = undefined;
      if (!controller.signal.aborted) {
        setBusy(false);
        setRetrying(false);
      }
    }
  };
  return (
    <div className="fdy-chat-file-download" aria-busy={busy}>
      <Button disabled={busy} onClick={() => void download()} size="sm">
        <Download aria-hidden="true" size={14} />
        {t(busy ? "detail.fileRead.downloading" : "detail.fileRead.download")}
      </Button>
      {busy ? (
        <p role="status">
          {progress.received > 0
            ? t(
                progress.total
                  ? "detail.fileRead.progress"
                  : "detail.fileRead.progressUnknown",
                {
                  received: formatBytes(progress.received),
                  total: formatBytes(progress.total || 0),
                },
              )
            : t(
                retrying
                  ? "detail.fileRead.retrying"
                  : "detail.fileRead.downloading",
              )}
        </p>
      ) : null}
      {error ? (
        <FileReadFeedback error={error} onRetry={() => void download()} />
      ) : null}
    </div>
  );
}
