import { useEffect, useState } from "react";
import {
  nextCronFire,
  type AgentSessionTimerFire,
  type AgentScheduledTask,
  type AgentSubagentTranscript,
  type WorkspaceFileRead,
} from "@foundry/protocol";
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
import { readWorkspaceFile } from "../../api";
import { Button } from "../../components/ui/button";
import { MarkdownContent } from "./chat-message-content";
import { ChatMessageList } from "./chat-message-list";
import { chatMessagesForSubagentTranscript } from "./chat-transcript-model";
import type { ChatContextSelection, ChatTimerItem } from "./chat-types";
import type { ParsedImageTag } from "./chat-message-content";
import { WorkspaceDirectoryBrowser } from "./workspace-directory-browser";

function panelKindLabel(
  selection: ChatContextSelection,
  browsedFileName?: string,
): string {
  if (browsedFileName) {
    return "工作区文件";
  }
  if (selection.kind === "subagent") {
    return "子智能体对话";
  }
  if (selection.kind === "timer") {
    return "定时任务";
  }
  if (selection.kind === "web") {
    return "网页预览";
  }
  if (selection.kind === "source") {
    return "来源";
  }
  return "文件";
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
  return (
    <article className="fdy-chat-detail-document">
      {file.truncated ? (
        <p className="fdy-chat-detail-note">文件较大，仅展示前 128 KB。</p>
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
  if (transcript.messages.length === 0) {
    return (
      <div className="fdy-chat-detail-empty">
        暂时还没有可展示的子智能体消息。
      </div>
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
  return (
    <div className="fdy-chat-detail-web">
      <div className="fdy-chat-detail-web-bar">
        <span>{url}</span>
        <a href={url} rel="noreferrer" target="_blank">
          <ExternalLink aria-hidden="true" size={14} />
          新窗口打开
        </a>
      </div>
      <iframe
        referrerPolicy="no-referrer"
        sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
        src={url}
        title={`Preview ${url}`}
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
  return date.toLocaleString("zh-CN", { hour12: false });
}

function TimerFireHistory({ fires }: { fires: AgentSessionTimerFire[] }) {
  if (fires.length === 0) {
    return <p className="fdy-chat-detail-note">还没有自动触发记录。</p>;
  }
  return (
    <div className="fdy-chat-timer-fires">
      <h4>触发记录（{fires.length}）</h4>
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
            <p className="fdy-chat-detail-note">该次触发没有文本结果。</p>
          )}
        </details>
      ))}
    </div>
  );
}

function TimerDetail({ item }: { item: ChatTimerItem }) {
  const task: AgentScheduledTask = item.task;
  const liveNext = nextCronFire(task.schedule)?.toISOString();
  return (
    <article className="fdy-chat-timer-detail">
      <dl className="fdy-chat-timer-meta">
        <div>
          <dt>类型</dt>
          <dd>{task.recurring ? "周期任务" : "单次提醒"}</dd>
        </div>
        <div>
          <dt>下次触发</dt>
          <dd>{formatTimerDateTime(liveNext ?? task.nextFireAt)}</dd>
        </div>
        <div>
          <dt>Cron 表达式</dt>
          <dd>
            <code>{task.schedule}</code>
          </dd>
        </div>
      </dl>
      <h4>触发时执行</h4>
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
    <aside className="fdy-chat-detail-panel" aria-label="Context detail">
      <header className="fdy-chat-detail-header">
        {browsedFile ? (
          <Button
            aria-label="返回工作区目录"
            className="fdy-chat-detail-back"
            onClick={() => setBrowsedFile(undefined)}
            size="icon"
            title="返回工作区目录"
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
          aria-label="Close context detail"
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
                正在加载…
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
            正在加载…
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
