import type { ReactNode } from "react";
import type {
  SessionFileRead,
  WorkspaceFileRead,
} from "@bd777/foundry-protocol";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert";
import { detailDocument } from "./chat-detail-parts";
import { Button } from "../../../components/ui/button";
import { CopyButton } from "../../../components/ui/copy-button";
import {
  formatFileSize,
  TextFileView,
} from "../../../components/workspace/workspace-file-view";
import type { ChatSessionFileItem } from "../chat-types";
import { WorkspaceImagePreview } from "../../../components/workspace/workspace-image-preview";
import { isInlineImageCandidate } from "../../../components/workspace/image-preview-model";

/** What a file read shows at most: workspace browsing and session files. */
const workspaceReadLimit = 128 * 1024;
const sessionReadLimit = 256 * 1024;

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
