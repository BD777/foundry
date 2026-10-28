import { useEffect, useState } from "react";
import type {
  AgentSubagentTranscript,
  SessionFileRead,
  WorkspaceFileRead,
} from "@bd777/foundry-protocol";
import {
  Bot,
  ChevronLeft,
  Clock,
  ExternalLink,
  FileDiff,
  FileText,
  FolderClosed,
  Monitor,
  Repeat,
  ScreenShare,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { readWorkspaceFile } from "../../api";
import { Button } from "../../components/ui/button";
import { fileIconForName } from "../../components/ui/file-tree";
import { subagentUsageSummary } from "../../components/conversation/turn-usage";
import { ChatMessageList } from "../../components/conversation/chat-message-list";
import { chatMessagesForSubagentTranscript } from "./chat-transcript-model";
import type { ChatContextSelection } from "./chat-types";
import { BackgroundKindIcon } from "./chat-context-background";
import { ChangeDetail } from "./chat-detail-change";
import { isSessionChange } from "./chat-context-model";
import { BackgroundTaskDetail } from "./chat-detail-background";
import { FileDetail, SessionFileView } from "./chat-detail-files";
import { TimerDetail } from "./chat-detail-timer";
import { ScreenDetail } from "./chat-detail-screen";
import type { ParsedImageTag } from "../../components/conversation/conversation-types";
import { WorkspaceDirectoryBrowser } from "./workspace-directory-browser";
import {
  ChatFileDownloadButton,
  ChatFileDownloadStatus,
  useChatFileDownload,
} from "./chat-file-download";
import { DeviceFileDetail } from "./chat-device-file";
import { FileReadFeedback } from "./chat-file-read-feedback";
import { requestDeviceFile } from "./device-file-request";
import { i18n } from "../../i18n";
import { LoadingState } from "../../components/ui/loading";

function panelKindLabel(
  selection: ChatContextSelection,
  browsedFileName?: string,
): string {
  if (browsedFileName) {
    return i18n.t("chat:detail.kind.workspaceFile");
  }
  if (selection.kind === "subagent") {
    return i18n.t("chat:detail.kind.subagent");
  }
  if (selection.kind === "timer") {
    return i18n.t("chat:detail.kind.timer");
  }
  if (selection.kind === "background-task") {
    return i18n.t("chat:detail.kind.background");
  }
  if (selection.kind === "web") {
    return i18n.t("chat:detail.kind.web");
  }
  if (selection.kind === "source" || selection.kind === "workspace-path") {
    return i18n.t("chat:detail.kind.source");
  }
  if (selection.kind === "device-file") {
    return i18n.t("chat:detail.kind.deviceFile");
  }
  if (selection.kind === "screen") {
    return i18n.t("chat:detail.kind.screen");
  }
  return selection.kind === "session-file" && isSessionChange(selection)
    ? i18n.t("chat:detail.kind.change")
    : i18n.t("chat:detail.kind.file");
}

function PanelKindIcon({
  browsedFileName,
  selection,
}: {
  browsedFileName?: string;
  selection: ChatContextSelection;
}) {
  if (browsedFileName) {
    return fileIconForName(browsedFileName, 17);
  }
  if (selection.kind === "subagent") {
    return <Bot aria-hidden="true" size={17} />;
  }
  if (selection.kind === "timer") {
    return selection.task.recurring ? (
      <Repeat aria-hidden="true" size={17} />
    ) : (
      <Clock aria-hidden="true" size={17} />
    );
  }
  if (selection.kind === "background-task") {
    return <BackgroundKindIcon kind={selection.task.kind} size={17} />;
  }
  if (selection.kind === "web") {
    return <Monitor aria-hidden="true" size={17} />;
  }
  if (selection.kind === "source" || selection.kind === "workspace-path") {
    return <FolderClosed aria-hidden="true" size={17} />;
  }
  if (selection.kind === "device-file") {
    return fileIconForName(selection.label, 17);
  }
  if (selection.kind === "screen") {
    return <ScreenShare aria-hidden="true" size={17} />;
  }
  if (selection.kind === "session-file") {
    if (isSessionChange(selection)) {
      return <FileDiff aria-hidden="true" size={17} />;
    }
    return fileIconForName(selection.label ?? selection.path, 17);
  }
  return <FileText aria-hidden="true" size={17} />;
}

function SubagentDetail({
  onImagePreview,
  transcript,
}: {
  onImagePreview?: (image: ParsedImageTag) => void;
  transcript: AgentSubagentTranscript;
}) {
  const { t } = useTranslation("chat");
  if (transcript.messages.length === 0) {
    return (
      <div className="fdy-chat-detail-empty">{t("detail.subagentEmpty")}</div>
    );
  }
  return (
    <div className="fdy-chat-detail-conversation">
      {transcript.usage ? (
        <p className="fdy-chat-detail-note">
          {t("detail.subagentUsage", {
            usage: subagentUsageSummary(transcript.usage),
          })}
        </p>
      ) : null}
      <ChatMessageList
        messages={chatMessagesForSubagentTranscript(transcript)}
        onImagePreview={onImagePreview}
      />
    </div>
  );
}

/** Where a workspace path's browser starts, and the file it opens first. */
function workspacePathView(selection: ChatContextSelection):
  | {
      folder: string;
      caption: string;
      /** The folder's name, the panel's heading while it is listed. */
      name: string;
      file?: { name: string; path: string };
    }
  | undefined {
  if (selection.kind !== "workspace-path") return undefined;
  if (selection.directory)
    return {
      folder: selection.path,
      caption: selection.detail,
      name: selection.label,
    };
  const parent = (path: string) => path.split("/").slice(0, -1).join("/");
  const caption = parent(selection.detail);
  return {
    folder: parent(selection.path),
    caption,
    name: caption.split("/").pop() || caption,
    file: { name: selection.label, path: selection.path },
  };
}

function WebDetail({ url }: { url: string }) {
  const { t } = useTranslation("chat");
  return (
    <div className="fdy-chat-detail-web">
      <div className="fdy-chat-detail-web-bar">
        <span>{url}</span>
        <a href={url} rel="noreferrer" target="_blank">
          <ExternalLink aria-hidden="true" size={14} />
          {t("detail.openInNewWindow")}
        </a>
      </div>
      <iframe
        referrerPolicy="no-referrer"
        sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
        src={url}
        title={t("detail.webPreviewTitle", { url })}
      />
    </div>
  );
}

export function ChatDetailPanel({
  canControl = false,
  error,
  file,
  loading,
  onClose,
  onRetry,
  retrying = false,
  onImagePreview,
  selection,
  transcript,
}: {
  /** The viewer may act on the session (members): stop background work. */
  canControl?: boolean;
  error?: unknown;
  file?: SessionFileRead;
  loading: boolean;
  onClose: () => void;
  onRetry?: () => void;
  retrying?: boolean;
  onImagePreview?: (image: ParsedImageTag) => void;
  selection: ChatContextSelection;
  transcript?: AgentSubagentTranscript;
}) {
  const { t } = useTranslation(["chat", "common"]);
  const pathView = workspacePathView(selection);
  const [browsedFile, setBrowsedFile] = useState<
    { name: string; path: string } | undefined
  >(() => pathView?.file);
  const [browsedFileRead, setBrowsedFileRead] = useState<WorkspaceFileRead>();
  const [browsedFileLoading, setBrowsedFileLoading] = useState(false);
  const [browsedFileError, setBrowsedFileError] = useState<unknown>();
  const [browseAttempt, setBrowseAttempt] = useState(0);
  const [browseRetrying, setBrowseRetrying] = useState(false);

  useEffect(() => {
    // A named file opens at once; back leads to its folder.
    setBrowsedFile(workspacePathView(selection)?.file);
    setBrowsedFileRead(undefined);
    setBrowsedFileError(undefined);
  }, [selection]);

  useEffect(() => {
    if (!browsedFile || !selection.workspaceId) {
      setBrowsedFileRead(undefined);
      setBrowsedFileLoading(false);
      return undefined;
    }
    const workspaceId = selection.workspaceId;
    const controller = new AbortController();
    setBrowsedFileLoading(true);
    setBrowseRetrying(false);
    setBrowsedFileRead(undefined);
    setBrowsedFileError(undefined);
    requestDeviceFile(
      () =>
        readWorkspaceFile(
          {
            path: browsedFile.path,
            workspaceId,
          },
          { signal: controller.signal },
        ),
      controller.signal,
      () => setBrowseRetrying(true),
    )
      .then((res) => {
        if (!controller.signal.aborted) {
          setBrowsedFileRead(res);
        }
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          setBrowsedFileError(err);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setBrowsedFileLoading(false);
        }
      });
    return () => controller.abort();
  }, [browsedFile, selection.workspaceId, browseAttempt]);

  // The file shown, downloaded from the title bar.
  const download = useChatFileDownload(
    browsedFile
      ? browsedFileRead
        ? { path: browsedFile.path, workspaceId: selection.workspaceId }
        : undefined
      : selection.kind === "session-file" && file && file.kind !== "missing"
        ? { path: selection.path, sessionId: selection.sessionId }
        : undefined,
  );

  return (
    <aside className="fdy-chat-detail-panel" aria-label={t("detail.label")}>
      <header className="fdy-chat-detail-header">
        {browsedFile ? (
          <Button
            aria-label={t("detail.backToDirectory")}
            className="fdy-chat-detail-back"
            onClick={() => setBrowsedFile(undefined)}
            size="icon"
            title={t("detail.backToDirectory")}
            variant="ghost"
          >
            <ChevronLeft size={16} />
          </Button>
        ) : null}
        <span className="fdy-chat-detail-kind-icon">
          <PanelKindIcon
            browsedFileName={browsedFile?.name}
            selection={selection}
          />
        </span>
        <span className="fdy-chat-detail-heading">
          <em>{panelKindLabel(selection, browsedFile?.name)}</em>
          <strong>
            {browsedFile?.name ?? pathView?.name ?? selection.label}
          </strong>
        </span>
        {download.available ? (
          <ChatFileDownloadButton state={download} />
        ) : null}
        <Button
          aria-label={t("detail.close")}
          onClick={onClose}
          size="icon"
          variant="ghost"
        >
          <X size={17} />
        </Button>
      </header>

      <div className="fdy-chat-detail-body">
        {selection.kind === "source" || pathView ? (
          browsedFile ? (
            browsedFileLoading ? (
              <LoadingState
                label={t(
                  browseRetrying
                    ? "detail.fileRead.retrying"
                    : "common:states.loading",
                )}
                layout="block"
              />
            ) : browsedFileError ? (
              <div className="fdy-chat-detail-feedback">
                <FileReadFeedback
                  error={browsedFileError}
                  onRetry={() => setBrowseAttempt((value) => value + 1)}
                />
              </div>
            ) : browsedFileRead ? (
              <>
                <ChatFileDownloadStatus state={download} />
                <FileDetail file={browsedFileRead} />
              </>
            ) : null
          ) : (
            <WorkspaceDirectoryBrowser
              onSelectFile={(selected) => setBrowsedFile(selected)}
              rootPath={
                selection.kind === "source"
                  ? selection.target
                  : pathView?.caption
              }
              startPath={pathView?.folder}
              workspaceId={selection.workspaceId ?? ""}
            />
          )
        ) : loading ? (
          <LoadingState
            label={t(
              retrying ? "detail.fileRead.retrying" : "common:states.loading",
            )}
            layout="block"
          />
        ) : error ? (
          <div className="fdy-chat-detail-feedback">
            <FileReadFeedback error={error} onRetry={onRetry} />
          </div>
        ) : selection.kind === "web" ? (
          <WebDetail url={selection.target} />
        ) : selection.kind === "device-file" ? (
          <DeviceFileDetail item={selection} key={selection.id} />
        ) : selection.kind === "screen" ? (
          <ScreenDetail
            item={selection}
            onClose={onClose}
            onImagePreview={onImagePreview}
          />
        ) : selection.kind === "timer" ? (
          <TimerDetail item={selection} />
        ) : selection.kind === "background-task" ? (
          <BackgroundTaskDetail canControl={canControl} item={selection} />
        ) : selection.kind === "subagent" && transcript ? (
          <SubagentDetail
            onImagePreview={onImagePreview}
            transcript={transcript}
          />
        ) : selection.kind === "session-file" && file ? (
          <>
            <ChatFileDownloadStatus state={download} />
            {isSessionChange(selection) ? (
              <ChangeDetail
                file={file}
                item={selection}
                key={`${selection.id}\u0000${selection.diffTurnId ?? ""}`}
              />
            ) : (
              <SessionFileView file={file} item={selection} />
            )}
            {file.kind === "missing" && onRetry ? (
              <Button onClick={onRetry} size="sm">
                {t("detail.fileRead.retry")}
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
    </aside>
  );
}
