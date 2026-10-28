import { useEffect, useRef, useState } from "react";
import { Download, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { apiBaseUrl } from "../../lib/api-base-url";
import { apiErrorOf, apiFetch } from "../../api/http";
import { Button } from "../../components/ui/button";
import { Tooltip } from "../../components/ui/tooltip";
import { FileReadFeedback } from "./chat-file-read-feedback";
import {
  readResponseBlob,
  type ReadProgress,
} from "../../lib/read-response-blob";
import { formatBytes } from "../../lib/format";
import { requestDeviceFile } from "./device-file-request";
import { deviceFileIntentHeaders } from "../../api";

/** The file a download fetches: a workspace, session or device file. */
export interface ChatFileDownloadTarget {
  /** A file of this device outside its workspaces, for its owner. */
  deviceId?: string;
  path: string;
  workspaceId?: string;
  sessionId?: string;
}

export type ChatFileDownloadState = ReturnType<typeof useChatFileDownload>;

/**
 * Downloads one file through the browser, with its progress, device retries
 * and failure; a new target cancels the old download and clears its state.
 */
export function useChatFileDownload(
  target: ChatFileDownloadTarget | undefined,
) {
  const { deviceId, path = "", workspaceId, sessionId } = target ?? {};
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
  }, [deviceId, path, workspaceId, sessionId]);

  const download = async () => {
    if (active.current || !target) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setProgress({ received: 0 });
    setRetrying(false);
    setError(undefined);
    const params = new URLSearchParams({ path });
    if (!sessionId && !deviceId) params.set("workspaceId", workspaceId ?? "");
    const endpoint = deviceId
      ? `/api/devices/${encodeURIComponent(deviceId)}/files/download`
      : sessionId
        ? `/api/agent-sessions/${encodeURIComponent(sessionId)}/files/download`
        : "/api/workspace-files/download";
    try {
      const blob = await requestDeviceFile(
        async () => {
          setProgress({ received: 0 });
          const response = await apiFetch(
            `${apiBaseUrl}${endpoint}?${params}`,
            {
              signal: controller.signal,
              cache: "no-store",
              ...(deviceId ? { headers: deviceFileIntentHeaders } : {}),
            },
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
  return {
    available: Boolean(target),
    busy,
    download,
    error,
    progress,
    retrying,
  };
}

/** The panel title bar's download action: an icon, spinning while busy. */
export function ChatFileDownloadButton({
  state,
}: {
  state: ChatFileDownloadState;
}) {
  const { t } = useTranslation("chat");
  const label = t(
    state.busy ? "detail.fileRead.downloading" : "detail.fileRead.download",
  );
  return (
    <Tooltip content={label}>
      <Button
        aria-busy={state.busy}
        aria-label={label}
        className="fdy-chat-file-download-icon"
        // aria-disabled, not disabled: keyboard focus stays on the button.
        aria-disabled={state.busy}
        data-error={state.error ? "true" : undefined}
        onClick={() => void state.download()}
        size="icon"
        variant="ghost"
      >
        {state.busy ? (
          <LoaderCircle aria-hidden="true" size={16} />
        ) : (
          <Download aria-hidden="true" size={16} />
        )}
      </Button>
    </Tooltip>
  );
}

/** A download's progress or failure, shown only while there is one. */
export function ChatFileDownloadStatus({
  state,
}: {
  state: ChatFileDownloadState;
}) {
  const { t } = useTranslation("chat");
  const { busy, error, progress, retrying } = state;
  if (!busy && !error) return null;
  return (
    <div className="fdy-chat-file-download" aria-busy={busy}>
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
        <FileReadFeedback error={error} onRetry={() => void state.download()} />
      ) : null}
    </div>
  );
}

/** A labeled download button with its status, for a file shown in a body. */
export function ChatFileDownload(target: ChatFileDownloadTarget) {
  const { t } = useTranslation("chat");
  const state = useChatFileDownload(target);
  return (
    <>
      <div className="fdy-chat-file-download">
        <Button
          disabled={state.busy}
          onClick={() => void state.download()}
          size="sm"
        >
          <Download aria-hidden="true" size={14} />
          {t(
            state.busy
              ? "detail.fileRead.downloading"
              : "detail.fileRead.download",
          )}
        </Button>
      </div>
      <ChatFileDownloadStatus state={state} />
    </>
  );
}
