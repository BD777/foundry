import { useState, type ReactNode } from "react";
import type {
  SessionFileRead,
  WorkspaceFileRead,
} from "@bd777/foundry-protocol";
import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert";
import { detailDocument } from "./chat-detail-parts";
import { Button } from "../../../components/ui/button";
import { CopyButton } from "../../../components/ui/copy-button";
import { SegmentedControl } from "../../../components/ui/segmented-control";
import { MarkdownContent } from "../../../components/conversation/markdown-content";
import { formatBytes } from "../../../lib/format";
import type { ChatSessionFileItem } from "../chat-types";
import { WorkspaceImagePreview } from "./chat-image-file-preview";
import { isInlineImageCandidate } from "./chat-image-preview-model";

export const markdownExtensions = new Set(["md", "markdown", "mdx"]);
export const htmlExtensions = new Set(["html", "htm"]);

export function extensionOf(path: string): string {
  const name = path.split("/").pop() ?? "";
  return name.includes(".")
    ? name.slice(name.lastIndexOf(".") + 1).toLowerCase()
    : "";
}

export function formatFileSize(bytes: number): string {
  return formatBytes(bytes, { kbDigits: 1, trimZeros: true });
}

/** What a file read shows at most: workspace browsing and session files. */
const workspaceReadLimit = 128 * 1024;
const sessionReadLimit = 256 * 1024;

/** HTML file with live preview and source code switcher. */
export function HtmlFileView({
  content,
  path,
}: {
  content: string;
  path: string;
}) {
  const { t } = useTranslation("chat");
  const [mode, setMode] = useState<"preview" | "code">("preview");

  const openInNewWindow = () => {
    const blob = new Blob([content], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };

  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <SegmentedControl
          aria-label={t("detail.htmlModeLabel")}
          onValueChange={(val) => setMode(val as "preview" | "code")}
          options={[
            { label: t("detail.htmlPreview"), value: "preview" },
            { label: t("detail.htmlCode"), value: "code" },
          ]}
          size="sm"
          value={mode}
        />
        <Button
          className="inline-flex items-center gap-1.5 text-ink-muted"
          onClick={openInNewWindow}
          size="sm"
          variant="ghost"
        >
          <ExternalLink aria-hidden="true" size={14} />
          {t("detail.openInNewWindow")}
        </Button>
      </div>

      {mode === "preview" ? (
        <div className="h-[600px] min-h-[400px] w-full overflow-hidden rounded-lg border border-line bg-surface">
          <iframe
            className="block h-full w-full border-0 bg-surface"
            sandbox="allow-scripts allow-forms allow-popups"
            srcDoc={content}
            title={path}
          />
        </div>
      ) : (
        <div className="fdy-markdown">
          <pre className="text-xs">
            <code>{content}</code>
          </pre>
        </div>
      )}
    </div>
  );
}

/** Text by its type: Markdown rendered, HTML with preview, anything else as code. */
export function TextFileView({
  content,
  path,
}: {
  content: string;
  path: string;
}) {
  const ext = extensionOf(path);
  if (htmlExtensions.has(ext)) {
    return <HtmlFileView content={content} path={path} />;
  }
  return markdownExtensions.has(ext) ? (
    <div className="fdy-markdown">
      <MarkdownContent>{content}</MarkdownContent>
    </div>
  ) : (
    <div className="fdy-markdown">
      <pre className="text-xs">
        <code>{content}</code>
      </pre>
    </div>
  );
}

/** A file browsed in the workspace folder. */
export function FileDetail({ file }: { file: WorkspaceFileRead }) {
  const { t } = useTranslation("chat");
  if (isInlineImageCandidate(file.path)) {
    return (
      <article className={detailDocument}>
        <WorkspaceImagePreview file={file} />
      </article>
    );
  }
  // As the device judges a session file: a NUL in the first 8 KB.
  if (file.content.slice(0, 8192).includes("\u0000"))
    return (
      <article className={detailDocument}>
        <Alert
          className="mb-4"
          size="compact"
          title={t("detail.fileBinaryDownload")}
        />
      </article>
    );
  return (
    <article className={detailDocument}>
      {file.truncated ? (
        <Alert
          className="mb-4"
          size="compact"
          title={t("detail.fileTruncated", {
            size: formatFileSize(workspaceReadLimit),
          })}
        />
      ) : null}
      <TextFileView content={file.content} path={file.path} />
    </article>
  );
}

/** One of the chat's files, shown by its type, with what changed since. */
export function SessionFileView({
  file,
  item,
  onRetry,
  toolbar,
}: {
  file: SessionFileRead;
  item: ChatSessionFileItem;
  /** Reads the file again; offered inside the "not there" notices. */
  onRetry?: () => void;
  /** Controls above the file, such as a change's Diff / File switch. */
  toolbar?: ReactNode;
}) {
  return (
    <article className={detailDocument}>
      {toolbar}
      <SessionFileContent file={file} item={item} onRetry={onRetry} />
    </article>
  );
}

/** A file's path, notices and content, inside its document. */
export function SessionFileContent({
  file,
  item,
  onRetry,
}: {
  file: SessionFileRead;
  item: ChatSessionFileItem;
  onRetry?: () => void;
}) {
  const { t } = useTranslation("chat");
  const device = item.deviceLabel || t("detail.thisDevice");
  const retry = onRetry ? (
    <Button onClick={onRetry} size="sm">
      {t("detail.fileRead.retry")}
    </Button>
  ) : undefined;
  return (
    <>
      <FilePathLine
        path={item.workspacePath ?? file.workspacePath ?? file.path}
        title={file.path}
      />
      {file.kind === "missing" && item.pending ? (
        <Alert
          className="fdy-chat-file-banner mb-4"
          tone="info"
          title={t("detail.fileNotYet", { device })}
          actions={retry}
        >
          {t("detail.fileNotYetHint")}
        </Alert>
      ) : file.kind === "missing" ? (
        <Alert
          className="fdy-chat-file-banner mb-4"
          tone="warning"
          title={t("detail.fileMissing", { device })}
          actions={retry}
        />
      ) : null}
      {file.changedSinceRecorded ? (
        <Alert
          className="fdy-chat-file-banner mb-4"
          tone="info"
          title={t("detail.fileChanged", { device })}
        />
      ) : null}
      {file.truncated ? (
        <Alert
          className="mb-4"
          size="compact"
          title={t("detail.fileTruncated", {
            size: formatFileSize(sessionReadLimit),
          })}
        />
      ) : null}
      {file.kind === "text" ? (
        <TextFileView content={file.content ?? ""} path={file.path} />
      ) : file.kind === "image" && file.dataBase64 ? (
        <figure>
          <img
            className="block h-auto max-w-full rounded-md border border-line"
            alt={item.label}
            src={`data:${file.mimeType};base64,${file.dataBase64}`}
          />
        </figure>
      ) : file.kind === "image" || file.kind === "binary" ? (
        <Alert
          className="mb-4"
          size="compact"
          title={t("detail.fileBinary", {
            size: formatFileSize(file.bytes ?? 0),
          })}
        />
      ) : null}
    </>
  );
}

/** A file's path as selectable text, with a button that copies it. */
export function FilePathLine({ path, title }: { path: string; title: string }) {
  const { t } = useTranslation(["chat", "common"]);
  return (
    <p
      className="fdy-chat-file-path mb-4 flex items-start gap-1 font-mono text-2xs wrap-anywhere text-ink-faint"
      title={title}
    >
      <span className="min-w-0 pt-[3px] select-text">{path}</span>
      <CopyButton
        className="size-[22px] flex-none text-ink-muted data-[copied=true]:text-success-text"
        copiedLabel={t("common:actions.copied")}
        label={t("detail.copyPath")}
        text={path}
      />
    </p>
  );
}
