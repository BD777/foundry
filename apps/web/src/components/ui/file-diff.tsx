import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Diff, Hunk, parseDiff, type FileData } from "react-diff-view";
import { Alert } from "./alert";
import type { FileDiffError } from "./file-diff-engine";
import { SegmentedControl } from "./segmented-control";

/** Shared lazy file viewer. Algorithms run in a cancellable worker, never in the list render. */
export function FileDiff({
  before,
  after,
  viewType,
  onViewTypeChange,
  errorCopy = "archives",
}: {
  before: string;
  after: string;
  viewType?: "unified" | "split";
  onViewTypeChange?: (view: "unified" | "split") => void;
  /** What failures point to: the downloadable archives, or the file itself. */
  errorCopy?: "archives" | "file";
}) {
  const { t } = useTranslation("ui");
  const [files, setFiles] = useState<FileData[]>();
  const [error, setError] = useState<
    FileDiffError | "timedOut" | "display" | "worker" | ""
  >("");
  const [localView, setLocalView] = useState<"unified" | "split">("unified");
  const view = viewType ?? localView;
  const setView = (next: "unified" | "split") => {
    setLocalView(next);
    onViewTypeChange?.(next);
  };
  useEffect(() => {
    setFiles(undefined);
    setError("");
    const worker = new Worker(
      new URL("./file-diff.worker.ts", import.meta.url),
      { type: "module" },
    );
    const timer = setTimeout(() => {
      worker.terminate();
      setError("timedOut");
    }, 2500);
    worker.onmessage = (
      event: MessageEvent<{ patch?: string; error?: FileDiffError }>,
    ) => {
      clearTimeout(timer);
      worker.terminate();
      if (event.data.error) {
        setError(event.data.error);
        return;
      }
      try {
        setFiles(parseDiff(event.data.patch ?? "", { nearbySequences: "zip" }));
      } catch {
        setError("display");
      }
    };
    worker.onerror = () => {
      clearTimeout(timer);
      setError("worker");
      worker.terminate();
    };
    worker.postMessage({ before, after });
    return () => {
      clearTimeout(timer);
      worker.terminate();
    };
  }, [before, after]);
  return (
    // react-diff-view's documented colour variables, on the app's tokens.
    // A side with no line (a new or deleted file's empty side) stays blank.
    <div className="fdy-text-diff grid min-w-0 gap-3 [--diff-background-color:var(--fdy-paper-main)] [--diff-code-delete-background-color:var(--fdy-error-surface)] [--diff-code-insert-background-color:var(--fdy-success-surface)] [--diff-gutter-delete-background-color:var(--fdy-error-surface)] [--diff-gutter-insert-background-color:var(--fdy-success-surface)] [--diff-omit-gutter-line-color:transparent] [--diff-selection-background-color:var(--fdy-selection)] [--diff-text-color:var(--fdy-ink)]">
      <SegmentedControl
        aria-label={t("fileDiff.layout")}
        size="sm"
        value={view}
        onValueChange={setView}
        options={[
          { label: t("fileDiff.unified"), value: "unified" },
          { label: t("fileDiff.split"), value: "split" },
        ]}
      />
      {error ? (
        <Alert
          size="compact"
          title={t(
            errorCopy === "file"
              ? `fileDiff.fileErrors.${error}`
              : `fileDiff.errors.${error}`,
          )}
          tone="error"
        />
      ) : !files ? (
        <p role="status">{t("fileDiff.calculating")}</p>
      ) : files.every((f) => !f.hunks.length) ? (
        <p>{t("fileDiff.noChanges")}</p>
      ) : (
        <div className="min-w-0 text-xs">
          {files.map((f, i) => (
            <Diff
              key={i}
              viewType={view}
              diffType={f.type}
              hunks={f.hunks}
              renderGutter={({ change, side, renderDefault, wrapInAnchor }) => {
                const sign =
                  change.type === "insert" && side === "new"
                    ? "+"
                    : change.type === "delete" && side === "old"
                      ? "−"
                      : "";
                return wrapInAnchor(
                  <>
                    {sign ? (
                      <span
                        aria-label={
                          sign === "+"
                            ? t("fileDiff.addedLine")
                            : t("fileDiff.removedLine")
                        }
                      >
                        {sign}
                      </span>
                    ) : null}
                    {renderDefault()}
                  </>,
                );
              }}
            >
              {(hunks) => hunks.map((h) => <Hunk key={h.content} hunk={h} />)}
            </Diff>
          ))}
        </div>
      )}
    </div>
  );
}
