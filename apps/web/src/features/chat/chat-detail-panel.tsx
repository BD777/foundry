import { useEffect, useState } from "react";
import {
  nextCronFire,
  type AgentSessionTimerFire,
  type AgentScheduledTask,
  type AgentSubagentTranscript,
  type WorkspaceFileRead,
} from "@bd777/foundry-protocol";
import {
  Bot,
  ChevronLeft,
  Clock,
  ExternalLink,
  FileText,
  FolderClosed,
  LoaderCircle,
  Monitor,
  Repeat,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { readWorkspaceFile } from "../../api";
import { Button } from "../../components/ui/button";
import { MarkdownContent } from "./chat-message-content";
import { ChatMessageList } from "./chat-message-list";
import { chatMessagesForSubagentTranscript } from "./chat-transcript-model";
import type { ChatContextSelection, ChatTimerItem } from "./chat-types";
import type { ParsedImageTag } from "./chat-message-content";
import { WorkspaceDirectoryBrowser } from "./workspace-directory-browser";
import { i18n } from "../../i18n";

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
  if (selection.kind === "web") {
    return i18n.t("chat:detail.kind.web");
  }
  if (selection.kind === "source") {
    return i18n.t("chat:detail.kind.source");
  }
  return i18n.t("chat:detail.kind.file");
}

function PanelKindIcon({
  browsedFileName,
  selection,
}: {
  browsedFileName?: string;
  selection: ChatContextSelection;
}) {
  if (browsedFileName) {
    return <FileText aria-hidden="true" size={17} />;
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
  if (selection.kind === "web") {
    return <Monitor aria-hidden="true" size={17} />;
  }
  if (selection.kind === "source") {
    return <FolderClosed aria-hidden="true" size={17} />;
  }
  return <FileText aria-hidden="true" size={17} />;
}

function FileDetail({ file }: { file: WorkspaceFileRead }) {
  const { t } = useTranslation("chat");
  return (
    <article className="fdy-chat-detail-document">
      {file.truncated ? (
        <p className="fdy-chat-detail-note">{t("detail.fileTruncated")}</p>
      ) : null}
      <MarkdownContent>{file.content}</MarkdownContent>
    </article>
  );
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
      <ChatMessageList
        messages={chatMessagesForSubagentTranscript(transcript)}
        onImagePreview={onImagePreview}
      />
    </div>
  );
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

function formatTimerDateTime(iso?: string): string {
  if (!iso) {
    return "—";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return date.toLocaleString(i18n.language, { hour12: false });
}

function TimerFireHistory({ fires }: { fires: AgentSessionTimerFire[] }) {
  const { t } = useTranslation("chat");
  if (fires.length === 0) {
    return <p className="fdy-chat-detail-note">{t("detail.timer.noFires")}</p>;
  }
  return (
    <div className="fdy-chat-timer-fires">
      <h4>{t("detail.timer.fireHistory", { count: fires.length })}</h4>
      {fires.map((fire, index) => (
        <details
          className="fdy-chat-timer-fire"
          key={`${fire.completedAt}-${index}`}
          open={index === 0}
        >
          <summary>
            <Clock aria-hidden="true" size={13} />
            {formatTimerDateTime(fire.completedAt)}
          </summary>
          {fire.response ? (
            <MarkdownContent>{fire.response}</MarkdownContent>
          ) : (
            <p className="fdy-chat-detail-note">
              {t("detail.timer.noFireText")}
            </p>
          )}
        </details>
      ))}
    </div>
  );
}

function TimerDetail({ item }: { item: ChatTimerItem }) {
  const task: AgentScheduledTask = item.task;
  const liveNext = nextCronFire(task.schedule)?.toISOString();
  const { t } = useTranslation("chat");
  return (
    <article className="fdy-chat-timer-detail">
      <dl className="fdy-chat-timer-meta">
        <div>
          <dt>{t("detail.timer.type")}</dt>
          <dd>
            {task.recurring
              ? t("detail.timer.recurring")
              : t("detail.timer.oneShot")}
          </dd>
        </div>
        <div>
          <dt>{t("detail.timer.nextFire")}</dt>
          <dd>{formatTimerDateTime(liveNext ?? task.nextFireAt)}</dd>
        </div>
        <div>
          <dt>{t("detail.timer.cron")}</dt>
          <dd>
            <code>{task.schedule}</code>
          </dd>
        </div>
      </dl>
      <h4>{t("detail.timer.prompt")}</h4>
      <pre className="fdy-chat-timer-prompt">{task.prompt}</pre>
      <TimerFireHistory fires={item.fires} />
    </article>
  );
}

export function ChatDetailPanel({
  error,
  file,
  loading,
  onClose,
  onImagePreview,
  selection,
  transcript,
}: {
  error?: string;
  file?: WorkspaceFileRead;
  loading: boolean;
  onClose: () => void;
  onImagePreview?: (image: ParsedImageTag) => void;
  selection: ChatContextSelection;
  transcript?: AgentSubagentTranscript;
}) {
  const { t } = useTranslation(["chat", "common"]);
  const [browsedFile, setBrowsedFile] = useState<{
    name: string;
    path: string;
  }>();
  const [browsedFileRead, setBrowsedFileRead] = useState<WorkspaceFileRead>();
  const [browsedFileLoading, setBrowsedFileLoading] = useState(false);
  const [browsedFileError, setBrowsedFileError] = useState<string>();

  useEffect(() => {
    setBrowsedFile(undefined);
    setBrowsedFileRead(undefined);
    setBrowsedFileError(undefined);
  }, [selection]);

  useEffect(() => {
    if (!browsedFile || !selection.workspaceId) {
      setBrowsedFileRead(undefined);
      setBrowsedFileLoading(false);
      return undefined;
    }
    const controller = new AbortController();
    setBrowsedFileLoading(true);
    setBrowsedFileError(undefined);
    readWorkspaceFile(
      {
        path: browsedFile.path,
        workspaceId: selection.workspaceId,
      },
      { signal: controller.signal },
    )
      .then((res) => {
        if (!controller.signal.aborted) {
          setBrowsedFileRead(res);
        }
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          setBrowsedFileError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setBrowsedFileLoading(false);
        }
      });
    return () => controller.abort();
  }, [browsedFile, selection.workspaceId]);

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
          <strong>{browsedFile?.name ?? selection.label}</strong>
        </span>
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
        {selection.kind === "source" ? (
          browsedFile ? (
            browsedFileLoading ? (
              <div className="fdy-chat-detail-loading">
                <LoaderCircle aria-hidden="true" size={18} />
                {t("common:states.loading")}
              </div>
            ) : browsedFileError ? (
              <div className="fdy-chat-detail-error">{browsedFileError}</div>
            ) : browsedFileRead ? (
              <FileDetail file={browsedFileRead} />
            ) : null
          ) : (
            <WorkspaceDirectoryBrowser
              onSelectFile={(selected) => setBrowsedFile(selected)}
              rootPath={selection.target}
              workspaceId={selection.workspaceId ?? ""}
            />
          )
        ) : loading ? (
          <div className="fdy-chat-detail-loading">
            <LoaderCircle aria-hidden="true" size={18} />
            {t("common:states.loading")}
          </div>
        ) : error ? (
          <div className="fdy-chat-detail-error">{error}</div>
        ) : selection.kind === "web" ? (
          <WebDetail url={selection.target} />
        ) : selection.kind === "timer" ? (
          <TimerDetail item={selection} />
        ) : selection.kind === "subagent" && transcript ? (
          <SubagentDetail
            onImagePreview={onImagePreview}
            transcript={transcript}
          />
        ) : file ? (
          <FileDetail file={file} />
        ) : null}
      </div>
    </aside>
  );
}
