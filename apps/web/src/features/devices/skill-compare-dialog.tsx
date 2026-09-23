import * as Dialog from "@radix-ui/react-dialog";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type {
  DeviceSkill,
  PromotedSkill,
  SkillComparison,
  SkillFileComparison,
  SkillComparisonInput,
} from "@foundry/protocol";
import {
  compareSkillVersions,
  compareSkillFile,
  downloadSkillComparisonPackage,
} from "../../api";
import { Button } from "../../components/ui/button";
import { SelectMenu } from "../../components/ui/select-menu";
import { TextInput } from "../../components/ui/field";
const FileDiff = lazy(() =>
  import("../../components/ui/file-diff").then((m) => ({
    default: m.FileDiff,
  })),
);

export default function SkillCompareDialog({
  skill,
  target,
  onClose,
}: {
  skill: DeviceSkill;
  target: PromotedSkill;
  onClose: () => void;
}) {
  const focus = useRef(
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const [targetID, setTargetID] = useState(target.id);
  const candidates = skill.serverCandidates?.length
    ? skill.serverCandidates
    : [target];
  const selected = candidates.find((c) => c.id === targetID) ?? target;
  const [revision, setRevision] = useState(target.latestRevision);
  const [revisionDraft, setRevisionDraft] = useState(
    String(target.latestRevision),
  );
  const input = useMemo<SkillComparisonInput>(
    () => ({
      deviceId: skill.deviceId,
      root: skill.root,
      dirName: skill.dirName,
      sourceDigest: skill.sourceDigest ?? "",
      skillId: selected.id,
      revision,
    }),
    [
      skill.deviceId,
      skill.root,
      skill.dirName,
      skill.sourceDigest,
      selected.id,
      revision,
    ],
  );
  const [loadedKey, setLoadedKey] = useState("");
  const [comparison, setComparison] = useState<SkillComparison>();
  const [path, setPath] = useState("");
  const [fileFilter, setFileFilter] = useState("");
  const [file, setFile] = useState<SkillFileComparison>();
  const [loadedFileKey, setLoadedFileKey] = useState("");
  const [layout, setLayout] = useState<"unified" | "split">("unified");
  const [error, setError] = useState("");
  const [fileError, setFileError] = useState("");
  const [retry, setRetry] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const requestKey = JSON.stringify([input, retry]);
  const currentFileKey = JSON.stringify([input, path]);
  const cache = useRef(new Map<string, SkillFileComparison>());
  useEffect(() => {
    let active = true;
    const abort = new AbortController();
    setComparison(undefined);
    setPath("");
    setError("");
    setFile(undefined);
    cache.current.clear();
    compareSkillVersions(input, { signal: abort.signal })
      .then((value) => {
        if (active) {
          setComparison(value);
          setLoadedKey(requestKey);
          setPath(value.files[0]?.path ?? "");
        }
      })
      .catch((cause) => {
        if (active) {
          setLoadedKey(requestKey);
          setError(String(cause instanceof Error ? cause.message : cause));
        }
      });
    return () => {
      active = false;
      abort.abort();
    };
  }, [input, retry]);
  useEffect(() => {
    let active = true;
    const abort = new AbortController();
    setFile(undefined);
    setFileError("");
    if (!comparison || !path || loadedKey !== requestKey) return;
    const key = JSON.stringify([input, path]);
    const saved = cache.current.get(key);
    if (saved) {
      setFile(saved);
      setLoadedFileKey(key);
      return;
    }
    compareSkillFile({ ...input, path }, { signal: abort.signal })
      .then((value) => {
        if (active) {
          if (cache.current.size >= 8)
            cache.current.delete(cache.current.keys().next().value!);
          cache.current.set(key, value);
          setFile(value);
          setLoadedFileKey(key);
        }
      })
      .catch((cause) => {
        if (active) {
          setLoadedFileKey(key);
          setFileError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => {
      active = false;
      abort.abort();
    };
  }, [input, path, comparison, retry, loadedKey]);
  const filteredFiles =
    comparison?.files.filter((f) =>
      f.path.toLowerCase().includes(fileFilter.trim().toLowerCase()),
    ) ?? [];
  async function download(side: "local" | "server") {
    setDownloading(true);
    setDownloadError("");
    try {
      const blob = await downloadSkillComparisonPackage({ ...input, side });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${side}-${side === "server" ? selected.name : skill.name}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      setDownloadError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDownloading(false);
    }
  }
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fdy-connection-assign-overlay" />
        <Dialog.Content
          className="fdy-connection-assign-dialog fdy-skill-compare-dialog"
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            focus.current?.focus();
          }}
        >
          <header className="fdy-connection-assign-header">
            <div>
              <Dialog.Title>Compare {skill.name}</Dialog.Title>
              <Dialog.Description>
                Server rev {revision} → local scan. File contents load only when
                selected. Publishing is a separate action.
              </Dialog.Description>
            </div>
          </header>
          <div className="fdy-skill-promotion-body">
            <SelectMenu
              insideDialog
              ariaLabel="Server skill to compare"
              tone="field"
              value={selected.id}
              options={candidates.map((c) => ({
                value: c.id,
                label: c.name,
                meta: `${c.originDeviceLabel || "Another device"} · ${c.originDirName} · ${c.originRoot} · rev ${c.latestRevision}`,
              }))}
              onChange={(id) => {
                const c = candidates.find((c) => c.id === id)!;
                setTargetID(id);
                setRevision(c.latestRevision);
                setRevisionDraft(String(c.latestRevision));
              }}
            />
            <div className="fdy-skill-compare-version">
              <label>
                Server revision{" "}
                <TextInput
                  aria-label="Server revision"
                  tone="boxed"
                  type="number"
                  min={1}
                  max={selected.latestRevision}
                  value={revisionDraft}
                  onChange={(e) => setRevisionDraft(e.target.value)}
                />
              </label>
              <Button
                size="sm"
                variant="secondary"
                disabled={
                  !Number.isInteger(Number(revisionDraft)) ||
                  Number(revisionDraft) < 1 ||
                  Number(revisionDraft) > selected.latestRevision
                }
                onClick={() => setRevision(Number(revisionDraft))}
              >
                Compare revision
              </Button>
            </div>
            {error && loadedKey === requestKey ? (
              <p role="alert" className="fdy-skill-error">
                {error}
              </p>
            ) : !comparison || loadedKey !== requestKey ? (
              <p role="status">Loading file index…</p>
            ) : (
              <>
                <p>
                  {comparison.files.length} changed files ·{" "}
                  {comparison.unchanged} unchanged
                </p>
                {comparison.files.length ? (
                  <>
                    <TextInput
                      aria-label="Filter changed files"
                      tone="boxed"
                      value={fileFilter}
                      onChange={(e) => setFileFilter(e.target.value)}
                      placeholder="Find a changed file"
                    />
                    {filteredFiles.length > 200 ? (
                      <p>
                        Showing the first 200 matching files. Narrow the filter
                        to find a specific file.
                      </p>
                    ) : null}
                    <SelectMenu
                      insideDialog
                      ariaLabel="Changed file"
                      tone="field"
                      value={path}
                      options={filteredFiles.slice(0, 200).map((f) => ({
                        value: f.path,
                        label: f.path,
                        meta: f.kind,
                      }))}
                      onChange={setPath}
                    />
                    {fileError && loadedFileKey === currentFileKey ? (
                      <p role="alert" className="fdy-skill-error">
                        {fileError}
                      </p>
                    ) : !file || loadedFileKey !== currentFileKey ? (
                      <p role="status">Loading selected file…</p>
                    ) : file.unavailable ? (
                      <p>{file.unavailable}</p>
                    ) : (
                      <Suspense
                        fallback={<p role="status">Loading diff viewer…</p>}
                      >
                        <FileDiff
                          before={file.before}
                          after={file.after}
                          viewType={layout}
                          onViewTypeChange={setLayout}
                        />
                      </Suspense>
                    )}
                  </>
                ) : (
                  <p>The local scan matches this server revision.</p>
                )}
              </>
            )}
            {downloadError ? (
              <p role="alert" className="fdy-skill-error">
                {downloadError}
              </p>
            ) : null}
          </div>
          <footer className="fdy-connection-assign-actions fdy-skill-compare-actions">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setRetry((n) => n + 1)}
            >
              Retry
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={downloading}
              onClick={() => void download("server")}
            >
              Download server ZIP
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={downloading}
              onClick={() => void download("local")}
            >
              Download local ZIP
            </Button>
            <Button size="sm" onClick={onClose}>
              Close
            </Button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
