import { useEffect, useState, type ReactNode } from "react";
import {
  nextCronFire,
  type AgentBackgroundTaskOutput,
  type AgentSessionTimerFire,
  type AgentScheduledTask,
  type AgentSubagentTranscript,
  type SessionFileDiff,
  type SessionFileRead,
  type WorkspaceFileRead,
} from "@bd777/foundry-protocol";
import {
  Bot,
  ChevronLeft,
  CircleStop,
  Clock,
  ExternalLink,
  FileDiff,
  FileText,
  FolderClosed,
  LoaderCircle,
  Monitor,
  Repeat,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  isAbortError,
  readBackgroundTaskOutput,
  readSessionFileDiff,
  readWorkspaceFile,
  stopBackgroundTask,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { FileDiff as FileDiffView } from "../../components/ui/file-diff";
import { SegmentedControl } from "../../components/ui/segmented-control";
import { subagentUsageSummary } from "../../components/conversation/turn-usage";
import { MarkdownContent } from "./chat-message-content";
import { ChatMessageList } from "./chat-message-list";
import { chatMessagesForSubagentTranscript } from "./chat-transcript-model";
import type {
  ChatBackgroundTaskItem,
  ChatContextSelection,
  ChatSessionFileItem,
  ChatTimerItem,
} from "./chat-types";
import { BackgroundKindIcon, BackgroundStatusIcon } from "./chat-context-card";
import { formatDuration } from "../../components/conversation/turn-usage";
import { useSharedNow } from "./use-shared-now";
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
  if (selection.kind === "background-task") {
    return i18n.t("chat:detail.kind.background");
  }
  if (selection.kind === "web") {
    return i18n.t("chat:detail.kind.web");
  }
  if (selection.kind === "source") {
    return i18n.t("chat:detail.kind.source");
  }
  return selection.kind === "session-file" && selection.inGitRepo
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
  if (selection.kind === "background-task") {
    return <BackgroundKindIcon kind={selection.task.kind} size={17} />;
  }
  if (selection.kind === "web") {
    return <Monitor aria-hidden="true" size={17} />;
  }
  if (selection.kind === "source") {
    return <FolderClosed aria-hidden="true" size={17} />;
  }
  if (selection.kind === "session-file" && selection.inGitRepo) {
    return <FileDiff aria-hidden="true" size={17} />;
  }
  return <FileText aria-hidden="true" size={17} />;
}

const markdownExtensions = new Set(["md", "markdown", "mdx"]);

function extensionOf(path: string): string {
  const name = path.split("/").pop() ?? "";
  return name.includes(".")
    ? name.slice(name.lastIndexOf(".") + 1).toLowerCase()
    : "";
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Number((bytes / 1024).toFixed(1))} KB`;
  return `${Number((bytes / (1024 * 1024)).toFixed(1))} MB`;
}

/** What a file read shows at most: workspace browsing and session files. */
const workspaceReadLimit = 128 * 1024;
const sessionReadLimit = 256 * 1024;

/** Text by its type: Markdown rendered, anything else as code. */
function TextFileView({ content, path }: { content: string; path: string }) {
  return markdownExtensions.has(extensionOf(path)) ? (
    <div className="fdy-markdown">
      <MarkdownContent>{content}</MarkdownContent>
    </div>
  ) : (
    <div className="fdy-markdown">
      <pre className="fdy-chat-file-code">
        <code>{content}</code>
      </pre>
    </div>
  );
}

/** A file browsed in the workspace folder. */
function FileDetail({ file }: { file: WorkspaceFileRead }) {
  const { t } = useTranslation("chat");
  return (
    <article className="fdy-chat-detail-document">
      {file.truncated ? (
        <p className="fdy-chat-detail-note">
          {t("detail.fileTruncated", {
            size: formatFileSize(workspaceReadLimit),
          })}
        </p>
      ) : null}
      <TextFileView content={file.content} path={file.path} />
    </article>
  );
}

/** One of the chat's files, shown by its type, with what changed since. */
function SessionFileView({
  file,
  item,
  toolbar,
}: {
  file: SessionFileRead;
  item: ChatSessionFileItem;
  /** Controls above the file, such as a change's Diff / File switch. */
  toolbar?: ReactNode;
}) {
  const { t } = useTranslation("chat");
  const device = item.deviceLabel || t("detail.thisDevice");
  return (
    <article className="fdy-chat-detail-document">
      {toolbar}
      <p className="fdy-chat-file-path" title={file.path}>
        {item.workspacePath ?? file.path}
      </p>
      {file.kind === "missing" ? (
        <Alert
          className="fdy-chat-file-banner"
          tone="warning"
          title={t("detail.fileMissing", { device })}
        />
      ) : null}
      {file.changedSinceRecorded ? (
        <Alert
          className="fdy-chat-file-banner"
          tone="info"
          title={t("detail.fileChanged", { device })}
        />
      ) : null}
      {file.truncated ? (
        <p className="fdy-chat-detail-note">
          {t("detail.fileTruncated", {
            size: formatFileSize(sessionReadLimit),
          })}
        </p>
      ) : null}
      {file.kind === "text" ? (
        <TextFileView content={file.content ?? ""} path={file.path} />
      ) : file.kind === "image" && file.dataBase64 ? (
        <figure className="fdy-chat-file-image">
          <img
            alt={item.label}
            src={`data:${file.mimeType};base64,${file.dataBase64}`}
          />
        </figure>
      ) : file.kind === "image" || file.kind === "binary" ? (
        <p className="fdy-chat-detail-note">
          {t("detail.fileBinary", { size: formatFileSize(file.bytes ?? 0) })}
        </p>
      ) : null}
    </article>
  );
}

/** Diff layout, remembered across changes and reloads. */
const diffViewKey = "foundry.changeDiffView.v1";

function storedDiffView(): "unified" | "split" {
  try {
    return window.localStorage.getItem(diffViewKey) === "split"
      ? "split"
      : "unified";
  } catch {
    return "unified";
  }
}

/** Files a new one is better seen rendered than as all-added lines. */
const previewFirstExtensions = new Set([
  ...markdownExtensions,
  "csv",
  "gif",
  "htm",
  "html",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "webp",
]);

/**
 * A file the chat's tools changed in a Git work tree: what its writes
 * changed (one answer's, when opened from that answer's files), or the
 * file itself. A new document or image opens as the file.
 */
function ChangeDetail({
  file,
  item,
}: {
  file: SessionFileRead;
  item: ChatSessionFileItem;
}) {
  const { t } = useTranslation(["chat", "common"]);
  const [mode, setMode] = useState<"diff" | "file">(() =>
    item.op === "created" && previewFirstExtensions.has(extensionOf(item.path))
      ? "file"
      : "diff",
  );
  const [view, setView] = useState(storedDiffView);
  const [diff, setDiff] = useState<SessionFileDiff>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (mode !== "diff" || diff) return undefined;
    const controller = new AbortController();
    setError(undefined);
    readSessionFileDiff(item.sessionId, item.path, item.diffTurnId, {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setDiff(value);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted || isAbortError(reason)) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => controller.abort();
  }, [diff, item.diffTurnId, item.path, item.sessionId, mode]);

  const changeView = (next: "unified" | "split") => {
    setView(next);
    try {
      window.localStorage.setItem(diffViewKey, next);
    } catch {
      // The choice still holds for this panel.
    }
  };
  const device = item.deviceLabel || t("detail.thisDevice");
  const unavailable = diff
    ? diff.binary
      ? t("detail.diff.binary")
      : diff.tooLarge
        ? t("detail.diff.tooLarge")
        : diff.unavailable || diff.before === undefined
          ? t("detail.diff.unavailable")
          : undefined
    : undefined;
  const toolbar = (
    <div className="fdy-chat-change-bar">
      <SegmentedControl
        aria-label={t("detail.diff.modeLabel")}
        onValueChange={setMode}
        options={[
          { label: t("detail.diff.diff"), value: "diff" },
          { label: t("detail.diff.file"), value: "file" },
        ]}
        size="sm"
        value={mode}
      />
      <span className="fdy-chat-change-scope">
        {item.diffTurnId
          ? t("detail.diff.scopeTurn")
          : t("detail.diff.scopeChat")}
      </span>
    </div>
  );
  if (mode === "file")
    return <SessionFileView file={file} item={item} toolbar={toolbar} />;
  return (
    <article className="fdy-chat-detail-document">
      {toolbar}
      {error ? (
        <Alert
          className="fdy-chat-file-banner"
          title={t("detail.diff.failed")}
          tone="error"
        >
          {error}
        </Alert>
      ) : !diff ? (
        <div className="fdy-chat-detail-loading">
          <LoaderCircle aria-hidden="true" size={18} />
          {t("detail.diff.loading")}
        </div>
      ) : (
        <>
          <p className="fdy-chat-file-path" title={diff.path}>
            {item.workspacePath ?? diff.path}
          </p>
          <p className="fdy-chat-change-sides">
            {t("detail.diff.sides", {
              before: t(`detail.diff.before.${diff.beforeLabel}`),
              after: t(`detail.diff.after.${diff.afterLabel}`),
            })}
            {diff.added !== undefined && diff.removed !== undefined ? (
              <span
                aria-label={t("detail.diff.lineCounts", {
                  added: diff.added,
                  removed: diff.removed,
                })}
                className="fdy-chat-change-lines"
                role="img"
              >
                <span data-tone="added">+{diff.added}</span>
                <span data-tone="removed">−{diff.removed}</span>
              </span>
            ) : null}
          </p>
          {diff.source === "git-snapshot" ? (
            <Alert
              className="fdy-chat-file-banner"
              title={t("detail.diff.snapshotNote")}
              tone="info"
            />
          ) : diff.mayIncludeOtherEdits ? (
            <Alert
              className="fdy-chat-file-banner"
              title={t("detail.diff.otherEdits")}
              tone="warning"
            />
          ) : null}
          {diff.changedSince ? (
            <Alert
              className="fdy-chat-file-banner"
              title={t("detail.diff.changedSince", { device })}
              tone="info"
            />
          ) : null}
          {unavailable ? (
            <div className="fdy-chat-change-unavailable">
              <p>{unavailable}</p>
              <Button
                onClick={() => setMode("file")}
                size="sm"
                variant="secondary"
              >
                <FileText aria-hidden="true" size={14} />
                {t("detail.diff.viewFile")}
              </Button>
            </div>
          ) : (
            <FileDiffView
              after={diff.after ?? ""}
              before={diff.before ?? ""}
              errorCopy="file"
              onViewTypeChange={changeView}
              viewType={view}
            />
          )}
        </>
      )}
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
            <div className="fdy-chat-timer-fire-response fdy-markdown">
              <MarkdownContent>{fire.response}</MarkdownContent>
            </div>
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
    <article className="fdy-chat-meta-detail">
      <dl className="fdy-chat-meta-list">
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
      <pre className="fdy-chat-meta-pre">{task.prompt}</pre>
      <TimerFireHistory fires={item.fires} />
    </article>
  );
}

/** A running task's output is read again this often while it is open. */
const backgroundOutputRefreshMs = 5000;

/**
 * One background task: what it is, how long it ran and how it ended; for
 * members, its redacted command and the end of its output, refreshed while
 * it runs, and a way to stop it.
 */
function BackgroundTaskDetail({
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
  const [output, setOutput] = useState<AgentBackgroundTaskOutput>();
  const [outputError, setOutputError] = useState<string>();
  const [membersOnly, setMembersOnly] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string>();

  useEffect(() => {
    setOutput(undefined);
    setOutputError(undefined);
    setMembersOnly(false);
    setConfirming(false);
    setStopping(false);
    setStopError(undefined);
  }, [item.id]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const controller = new AbortController();
    const load = async () => {
      try {
        const value = await readBackgroundTaskOutput(item.sessionId, task.id, {
          signal: controller.signal,
        });
        if (cancelled) return;
        setOutput(value);
        setOutputError(undefined);
      } catch (reason) {
        if (cancelled || isAbortError(reason)) return;
        if ((reason as { status?: number }).status === 403) {
          setMembersOnly(true);
          return;
        }
        setOutputError(
          reason instanceof Error ? reason.message : String(reason),
        );
      }
      if (!cancelled && running)
        timer = window.setTimeout(() => void load(), backgroundOutputRefreshMs);
    };
    void load();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [item.sessionId, task.id, running]);

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
    <article className="fdy-chat-meta-detail">
      <dl className="fdy-chat-meta-list">
        <div>
          <dt>{t("detail.background.kind")}</dt>
          <dd>{t(`contextCard.backgroundKind.${task.kind}`)}</dd>
        </div>
        {item.ownerLabel ? (
          <div>
            <dt>{t("detail.background.startedBy")}</dt>
            <dd>{item.ownerLabel}</dd>
          </div>
        ) : null}
        <div>
          <dt>{t("detail.background.started")}</dt>
          <dd>{formatTimerDateTime(task.startedAt)}</dd>
        </div>
        <div>
          <dt>{t("detail.background.duration")}</dt>
          <dd>{duration}</dd>
        </div>
        {task.timeLimitMs ? (
          <div>
            <dt>{t("detail.background.timeLimit")}</dt>
            <dd>{formatDuration(task.timeLimitMs)}</dd>
          </div>
        ) : null}
        <div>
          <dt>{t("detail.background.status")}</dt>
          <dd>
            <span className="fdy-chat-context-status">
              <BackgroundStatusIcon status={task.status} />
              {t(`contextCard.backgroundStatus.${task.status}`)}
            </span>
            {task.stopReason ? (
              <> · {t(`detail.background.stopReason.${task.stopReason}`)}</>
            ) : null}
          </dd>
        </div>
        {task.exitCode !== undefined ? (
          <div>
            <dt>{t("detail.background.exitCode")}</dt>
            <dd>
              <code>{task.exitCode}</code>
            </dd>
          </div>
        ) : null}
      </dl>
      {task.summary ? (
        <>
          <h4>{t("detail.background.summary")}</h4>
          <p className="fdy-chat-meta-note">{task.summary}</p>
        </>
      ) : null}
      {running && canControl ? (
        <div className="fdy-chat-background-actions">
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
            <Alert tone="error" title={t("detail.background.stopFailed")}>
              {stopError}
            </Alert>
          ) : null}
        </div>
      ) : null}
      {membersOnly ? (
        <p className="fdy-chat-meta-note">
          {t("detail.background.membersOnly")}
        </p>
      ) : (
        <>
          {output?.command ? (
            <>
              <h4>{t("detail.background.command")}</h4>
              <pre className="fdy-chat-meta-pre">{output.command}</pre>
            </>
          ) : null}
          <h4>
            {t("detail.background.output")}
            {running ? (
              <small>{t("detail.background.outputLive")}</small>
            ) : null}
          </h4>
          {outputError ? (
            <div className="fdy-chat-detail-error">{outputError}</div>
          ) : !output ? (
            <div className="fdy-chat-detail-loading">
              <LoaderCircle aria-hidden="true" size={18} />
              {t("common:states.loading")}
            </div>
          ) : output.kind === "missing" ? (
            <p className="fdy-chat-meta-note">
              {running
                ? t("detail.background.outputEmpty")
                : t("detail.background.outputMissing")}
            </p>
          ) : output.kind === "binary" ? (
            <p className="fdy-chat-meta-note">
              {t("detail.background.outputBinary", {
                size: formatFileSize(output.bytes),
              })}
            </p>
          ) : output.content ? (
            <>
              {output.truncated ? (
                <p className="fdy-chat-meta-note">
                  {t("detail.background.outputTail", {
                    size: formatFileSize(64 * 1024),
                  })}
                </p>
              ) : null}
              <pre className="fdy-chat-meta-pre fdy-chat-background-output">
                {output.content}
              </pre>
            </>
          ) : (
            <p className="fdy-chat-meta-note">
              {t("detail.background.outputEmpty")}
            </p>
          )}
        </>
      )}
    </article>
  );
}

export function ChatDetailPanel({
  canControl = false,
  error,
  file,
  loading,
  onClose,
  onImagePreview,
  selection,
  transcript,
}: {
  /** The viewer may act on the session (members): stop background work. */
  canControl?: boolean;
  error?: string;
  file?: SessionFileRead;
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
        ) : selection.kind === "background-task" ? (
          <BackgroundTaskDetail canControl={canControl} item={selection} />
        ) : selection.kind === "subagent" && transcript ? (
          <SubagentDetail
            onImagePreview={onImagePreview}
            transcript={transcript}
          />
        ) : selection.kind === "session-file" && file ? (
          selection.inGitRepo ? (
            <ChangeDetail
              file={file}
              item={selection}
              key={`${selection.id}\u0000${selection.diffTurnId ?? ""}`}
            />
          ) : (
            <SessionFileView file={file} item={selection} />
          )
        ) : null}
      </div>
    </aside>
  );
}
