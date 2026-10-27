import { Alert } from "../ui/alert";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  DeviceSkill,
  PromotedSkill,
  SkillComparison,
  SkillFileComparison,
  SkillComparisonInput,
} from "@bd777/foundry-protocol";
import {
  compareSkillVersions,
  compareSkillFile,
  downloadSkillComparisonPackage,
} from "../../api";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { SelectMenu } from "../ui/select-menu";
import { TextInput } from "../ui/field";
const FileDiff = lazy(() =>
  import("../ui/file-diff").then((m) => ({
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
  const { t } = useTranslation(["skills", "common"]);
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
    <Dialog
      description={t("compare.body", { revision })}
      footer={
        <>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setRetry((n) => n + 1)}
          >
            {t("common:actions.retry")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={downloading}
            onClick={() => void download("server")}
          >
            {t("compare.downloadServer")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={downloading}
            onClick={() => void download("local")}
          >
            {t("compare.downloadLocal")}
          </Button>
          <Button size="sm" onClick={onClose}>
            {t("common:actions.close")}
          </Button>
        </>
      }
      layout="compact"
      onClose={onClose}
      size="large"
      title={t("compare.title", { name: skill.name })}
    >
      <div className="fdy-skill-promotion-body">
        <SelectMenu
          insideDialog
          ariaLabel={t("compare.targetLabel")}
          tone="field"
          value={selected.id}
          options={candidates.map((c) => ({
            value: c.id,
            label: c.name,
            meta: t("compare.targetMeta", {
              device: c.originDeviceLabel || t("versionChoice.anotherDevice"),
              dirName: c.originDirName,
              root: c.originRoot,
              revision: c.latestRevision,
            }),
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
            {t("compare.revisionLabel")}{" "}
            <TextInput
              aria-label={t("compare.revisionLabel")}
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
            {t("compare.compareRevision")}
          </Button>
        </div>
        {error && loadedKey === requestKey ? (
          <Alert tone="error" size="compact" title={error} />
        ) : !comparison || loadedKey !== requestKey ? (
          <p role="status">{t("compare.loadingIndex")}</p>
        ) : (
          <>
            <p>
              {t("compare.summary", {
                count: comparison.files.length,
                unchanged: comparison.unchanged,
              })}
            </p>
            {comparison.files.length ? (
              <>
                <TextInput
                  aria-label={t("compare.filterLabel")}
                  tone="boxed"
                  value={fileFilter}
                  onChange={(e) => setFileFilter(e.target.value)}
                  placeholder={t("compare.filterPlaceholder")}
                />
                {filteredFiles.length > 200 ? (
                  <p>{t("compare.truncated")}</p>
                ) : null}
                <SelectMenu
                  insideDialog
                  ariaLabel={t("compare.fileLabel")}
                  tone="field"
                  value={path}
                  options={filteredFiles.slice(0, 200).map((f) => ({
                    value: f.path,
                    label: f.path,
                    meta: t(`compare.fileKind.${f.kind}`),
                  }))}
                  onChange={setPath}
                />
                {fileError && loadedFileKey === currentFileKey ? (
                  <Alert tone="error" size="compact" title={fileError} />
                ) : !file || loadedFileKey !== currentFileKey ? (
                  <p role="status">{t("compare.loadingFile")}</p>
                ) : file.unavailable ? (
                  <p>{file.unavailable}</p>
                ) : (
                  <Suspense
                    fallback={<p role="status">{t("compare.loadingViewer")}</p>}
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
              <p>{t("compare.identical")}</p>
            )}
          </>
        )}
        {downloadError ? (
          <Alert tone="error" size="compact" title={downloadError} />
        ) : null}
      </div>
    </Dialog>
  );
}
