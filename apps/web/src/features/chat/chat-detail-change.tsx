import { useEffect, useState } from "react";
import type { SessionFileDiff, SessionFileRead } from "@bd777/foundry-protocol";
import { FileText, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { isAbortError, readSessionFileDiff } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { FileDiff as FileDiffView } from "../../components/ui/file-diff";
import { SegmentedControl } from "../../components/ui/segmented-control";
import {
  extensionOf,
  markdownExtensions,
  SessionFileView,
} from "./chat-detail-files";
import type { ChatSessionFileItem } from "./chat-types";

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
export function ChangeDetail({
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
