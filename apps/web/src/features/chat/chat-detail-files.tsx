import { useState, type ReactNode } from "react";
import type {
  SessionFileRead,
  WorkspaceFileRead,
} from "@bd777/foundry-protocol";
import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { SegmentedControl } from "../../components/ui/segmented-control";
import { MarkdownContent } from "../../components/conversation/markdown-content";
import { formatBytes } from "../../lib/format";
import type { ChatSessionFileItem } from "./chat-types";

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
    <div className="fdy-chat-file-html">
      <div className="fdy-chat-file-html-bar">
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
          className="fdy-chat-file-html-open"
          onClick={openInNewWindow}
          size="sm"
          variant="ghost"
        >
          <ExternalLink aria-hidden="true" size={14} />
          {t("detail.openInNewWindow")}
        </Button>
      </div>

      {mode === "preview" ? (
        <div className="fdy-chat-file-html-frame-wrap">
          <iframe
            className="fdy-chat-file-html-frame"
            sandbox="allow-scripts allow-forms allow-popups"
            srcDoc={content}
            title={path}
          />
        </div>
      ) : (
        <div className="fdy-markdown">
          <pre className="fdy-chat-file-code">
            <code>{content}</code>
          </pre>
        </div>
      )}
    </div>
  );
}

/** Text by its type: Markdown rendered, HTML with preview, anything else as code. */
function TextFileView({ content, path }: { content: string; path: string }) {
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
      <pre className="fdy-chat-file-code">
        <code>{content}</code>
      </pre>
    </div>
  );
}

/** A file browsed in the workspace folder. */
export function FileDetail({ file }: { file: WorkspaceFileRead }) {
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
export function SessionFileView({
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
        {item.workspacePath ?? file.workspacePath ?? file.path}
      </p>
      {file.kind === "missing" && item.pending ? (
        <Alert
          className="fdy-chat-file-banner"
          tone="info"
          title={t("detail.fileNotYet", { device })}
        >
          {t("detail.fileNotYetHint")}
        </Alert>
      ) : file.kind === "missing" ? (
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
