import { useEffect, useState } from "react";
import type {
  SessionFileDiff,
  SessionFileDiffAvailability,
  SessionFileRead,
} from "@bd777/foundry-protocol";
import { FileText } from "lucide-react";
import { useTranslation } from "react-i18next";
import { isAbortError, readSessionFileDiff } from "../../../api";
import { Alert } from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { FileDiff as FileDiffView } from "../../../components/ui/file-diff";
import { SegmentedControl } from "../../../components/ui/segmented-control";
import {
  extensionOf,
  FilePathLine,
  markdownExtensions,
  SessionFileContent,
  SessionFileView,
} from "./chat-detail-files";
import { detailDocument } from "./chat-detail-parts";
import type { ChatSessionFileItem } from "../chat-types";
import { LoadingState } from "../../../components/ui/loading";

/** Diff / File switch, then which two versions the diff compares. */
const changeBar = "mb-3.5 flex flex-wrap items-center gap-x-3 gap-y-2";

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
 * Why a change has no text diff, known before asking its device: what the
 * device reported when the turn ended, or before that, a file that reads as
 * binary.
 */
export function changeWithoutDiff(
  item: ChatSessionFileItem,
  file: SessionFileRead,
): Exclude<SessionFileDiffAvailability, "text"> | undefined {
  const known = item.diffTurnId ? item.turnDiff?.[item.diffTurnId] : item.diff;
  if (known) return known === "text" ? undefined : known;
  return file.kind === "binary" ||
    (file.kind === "image" && file.mimeType !== "image/svg+xml")
    ? "binary"
    : undefined;
}

/**
 * A file the chat's tools changed in a Git work tree: what its writes
 * changed (one answer's, when opened from that answer's files), or the
 * file itself. A new document or image opens as the file; a change with
 * no text diff shows only the file and says why.
 */
export function ChangeDetail({
  file,
  item,
  onRetry,
}: {
  file: SessionFileRead;
  item: ChatSessionFileItem;
  onRetry?: () => void;
}) {
  const { t } = useTranslation(["chat", "common"]);
  const withoutDiff = changeWithoutDiff(item, file);
  const [mode, setMode] = useState<"diff" | "file">(() =>
    withoutDiff ||
    (item.op === "created" &&
      previewFirstExtensions.has(extensionOf(item.path)))
      ? "file"
      : "diff",
  );
  const [view, setView] = useState(storedDiffView);
  const [diff, setDiff] = useState<SessionFileDiff>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (mode !== "diff" || diff || withoutDiff) return undefined;
    const controller = new AbortController();
    setError(undefined);
    readSessionFileDiff(
      item.diffSessionId ?? item.sessionId,
      item.path,
      item.diffTurnId,
      {
        signal: controller.signal,
      },
    )
      .then((value) => {
        if (!controller.signal.aborted) setDiff(value);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted || isAbortError(reason)) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => controller.abort();
  }, [
    diff,
    item.diffTurnId,
    item.diffSessionId,
    item.path,
    item.sessionId,
    mode,
    withoutDiff,
  ]);

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
  const newFile =
    item.op === "created" && !item.diffTurnId ? (
      <Badge dot={false}>{t("detail.diff.newFile")}</Badge>
    ) : null;
  if (withoutDiff)
    return (
      <SessionFileView
        file={file}
        item={item}
        onRetry={onRetry}
        toolbar={
          <div className={changeBar}>
            {newFile}
            <span className="text-2xs text-ink-faint">
              {t(`detail.diff.noDiff.${withoutDiff}`)}
            </span>
          </div>
        }
      />
    );
  const toolbar = (
    <div className={changeBar}>
      {newFile}
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
      <span className="text-2xs text-ink-faint">
        {item.diffTurnId
          ? t("detail.diff.scopeTurn")
          : t("detail.diff.scopeChat")}
      </span>
    </div>
  );
  // One document for both modes, so the switch keeps its place and focus.
  return (
    <article className={detailDocument}>
      {toolbar}
      {mode === "file" ? (
        <SessionFileContent file={file} item={item} onRetry={onRetry} />
      ) : error ? (
        <Alert
          className="fdy-chat-file-banner mb-4"
          title={t("detail.diff.failed")}
          tone="error"
        >
          {error}
        </Alert>
      ) : !diff ? (
        <LoadingState label={t("detail.diff.loading")} layout="block" />
      ) : (
        <>
          <FilePathLine
            path={item.workspacePath ?? diff.path}
            title={diff.path}
          />
          <p className="-mt-2 mb-3.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-xs text-ink-muted">
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
                className="inline-flex gap-1 font-semibold tabular-nums"
                role="img"
              >
                <span className="text-success-text">+{diff.added}</span>
                <span className="text-error-text">−{diff.removed}</span>
              </span>
            ) : null}
          </p>
          {diff.source === "git-snapshot" ? (
            <Alert
              className="fdy-chat-file-banner mb-4"
              title={t("detail.diff.snapshot")}
              tone="info"
            />
          ) : diff.mayIncludeOtherEdits ? (
            <Alert
              className="fdy-chat-file-banner mb-4"
              title={t("detail.diff.otherEdits")}
              tone="warning"
            />
          ) : null}
          {diff.changedSince ? (
            <Alert
              className="fdy-chat-file-banner mb-4"
              title={t("detail.diff.changedSince", { device })}
              tone="info"
            />
          ) : null}
          {unavailable ? (
            <Alert
              actions={
                <Button
                  onClick={() => setMode("file")}
                  size="sm"
                  variant="secondary"
                >
                  <FileText aria-hidden="true" size={14} />
                  {t("detail.diff.viewFile")}
                </Button>
              }
              size="compact"
              title={unavailable}
            />
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
