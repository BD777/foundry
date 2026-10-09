import { skillServerLabel } from "../../components/skills/skill-version-state";
import { type SkillServerFilter } from "./skill-search";
import { SkillPromotionDialog } from "../../components/skills/skill-promotion-dialog";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  FolderCog,
  FolderPlus,
  RefreshCw,
  UploadCloud,
  X,
  AlertTriangle,
} from "lucide-react";
import type {
  PromotedSkill,
  DeviceProjection,
  DeviceSkill,
  DeviceSkillRoot,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { scanDeviceSkills, setDeviceSkillRoots } from "../../api";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { TextInput } from "../../components/ui/field";
import { WorkspaceDialog } from "../../components/workspace/workspace-dialog";
import { SkillCatalogList } from "../../components/skills/skill-catalog-list";
import {
  skillWorkspace,
  toNormalizedDeviceSkill,
  type NormalizedSkill,
} from "../../components/skills/skill-models";
import { useDeviceSkills } from "../../components/skills/use-device-skills";

const SkillCompareDialog = lazy(
  () => import("../../components/skills/skill-compare-dialog"),
);

interface DeviceSkillsProps {
  device: DeviceProjection;
  roots: DeviceSkillRoot[];
  /** This device's workspaces, whose own skill folders are scanned too. */
  workspaces: WorkspaceProjection[];
  onChanged: () => Promise<void>;
}

function serverStatusOptions(t: TFunction<"skills">) {
  return [
    { value: "all", label: t("device.serverFilter.all") },
    { value: "unpublished", label: t("device.serverFilter.unpublished") },
    { value: "different", label: t("device.serverFilter.different") },
    { value: "same_name", label: t("device.serverFilter.sameName") },
    { value: "in_sync", label: t("device.serverFilter.inSync") },
    { value: "unknown", label: t("device.serverFilter.unknown") },
  ];
}

/**
 * Device-local skills: maintain scan roots, scan the machine, and promote
 * entries into the server catalog. Promotion is the only way a local skill
 * reaches a workspace — selection itself lives in the workspace Skills tab.
 */
export function DeviceSkills({
  device,
  roots,
  workspaces,
  onChanged,
}: DeviceSkillsProps) {
  const { t } = useTranslation(["skills", "common"]);
  const deviceSkills = useDeviceSkills(device);
  const skills = deviceSkills.skills;
  const [draftPaths, setDraftPaths] = useState<string[]>([]);
  const [draftDirty, setDraftDirty] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [rootsBusy, setRootsBusy] = useState(false);
  const [rootsOpen, setRootsOpen] = useState(false);
  const [rootsError, setRootsError] = useState<string>();
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string>();
  const [serverFilter, setServerFilter] = useState<SkillServerFilter>("all");
  const [comparison, setComparison] = useState<{
    skill: DeviceSkill;
    target: PromotedSkill;
  }>();
  const [promotion, setPromotion] = useState<DeviceSkill>();
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setDraftPaths(roots.map((root) => root.path));
    setDraftDirty(false);
    setLoaded(true);
  }, [roots]);

  const online = device.status === "connected";

  const normalizedSkills = useMemo(() => {
    return skills.map((skill) =>
      toNormalizedDeviceSkill(skill, skillWorkspace(skill, workspaces)),
    );
  }, [skills, workspaces]);

  function openRoots(): void {
    setDraftPaths(roots.map((root) => root.path));
    setDraftDirty(false);
    setNewPath("");
    setRootsError(undefined);
    setRootsOpen(true);
  }

  async function saveRoots(): Promise<void> {
    setRootsBusy(true);
    setRootsError(undefined);
    try {
      await setDeviceSkillRoots(device.id, draftPaths);
      setDraftDirty(false);
      await onChanged();
      setRootsOpen(false);
      if (online) await runScan();
    } catch (error) {
      setRootsError(error instanceof Error ? error.message : String(error));
    } finally {
      setRootsBusy(false);
    }
  }

  async function runScan(): Promise<void> {
    setScanning(true);
    setScanError(undefined);
    try {
      await scanDeviceSkills(device.id);
      await onChanged();
    } catch (error) {
      setScanError(error instanceof Error ? error.message : String(error));
    } finally {
      setScanning(false);
    }
  }

  if (!loaded || !deviceSkills.loaded) return null;
  const listError = scanError ?? deviceSkills.error;

  return (
    <div className="fdy-device-skills">
      {comparison ? (
        <Suspense
          fallback={<p role="status">{t("device.loadingComparison")}</p>}
        >
          <SkillCompareDialog
            onClose={() => setComparison(undefined)}
            skill={comparison.skill}
            target={comparison.target}
          />
        </Suspense>
      ) : null}
      {promotion ? (
        <SkillPromotionDialog
          onChanged={async () => {
            await onChanged();
            await deviceSkills.reload();
          }}
          onClose={() => setPromotion(undefined)}
          online={online}
          skill={promotion}
          skills={skills}
        />
      ) : null}
      {rootsOpen ? (
        <WorkspaceDialog
          busy={rootsBusy}
          description={t("device.rootsBody")}
          onClose={() => setRootsOpen(false)}
          title={t("device.rootsTitle")}
        >
          <div className="fdy-skill-roots">
            <ul>
              {draftPaths.map((path, index) => (
                <li className="fdy-skill-root-row" key={`${path}-${index}`}>
                  <span className="fdy-skill-root-path" title={path}>
                    {path}
                  </span>
                  {roots.find((root) => root.path === path)?.isDefault ? (
                    <Badge tone="neutral">{t("device.defaultRoot")}</Badge>
                  ) : null}
                  <Button
                    aria-label={t("device.removeRoot", { path })}
                    disabled={rootsBusy}
                    onClick={() => {
                      setDraftPaths((rows) =>
                        rows.filter((_, i) => i !== index),
                      );
                      setDraftDirty(true);
                    }}
                    size="icon"
                    variant="ghost"
                  >
                    <X size={14} />
                  </Button>
                </li>
              ))}
            </ul>
            <div className="fdy-skill-root-add">
              <TextInput
                aria-label={t("device.addRootLabel")}
                onChange={(event) => setNewPath(event.target.value)}
                placeholder={t("device.addRootPlaceholder")}
                tone="boxed"
                value={newPath}
              />
              <Button
                disabled={!newPath.trim() || rootsBusy}
                onClick={() => {
                  const path = newPath.trim();
                  if (path && !draftPaths.includes(path)) {
                    setDraftPaths((rows) => [...rows, path]);
                    setDraftDirty(true);
                  }
                  setNewPath("");
                }}
                variant="secondary"
              >
                <FolderPlus size={14} />
                {t("device.add")}
              </Button>
            </div>
            {rootsError ? (
              <p className="fdy-skill-error" role="alert">
                <AlertTriangle size={13} /> {rootsError}
              </p>
            ) : null}
            <div className="fdy-skill-root-actions">
              <Button
                disabled={rootsBusy}
                onClick={() => setRootsOpen(false)}
                variant="ghost"
              >
                {t("common:actions.cancel")}
              </Button>
              <Button
                disabled={!draftDirty || rootsBusy}
                onClick={() => void saveRoots()}
                variant="primary"
              >
                {rootsBusy ? t("common:actions.saving") : t("device.saveRoots")}
              </Button>
            </div>
          </div>
        </WorkspaceDialog>
      ) : null}

      <SkillCatalogList<NormalizedSkill>
        description={t("device.description")}
        headerActions={
          <>
            <Button onClick={openRoots} variant="secondary">
              <FolderCog size={14} />
              {t("device.rootsOpen", { count: roots.length })}
            </Button>
            <Button
              disabled={!online || scanning}
              onClick={() => void runScan()}
              variant="secondary"
            >
              <RefreshCw
                className={scanning ? "fdy-spin" : undefined}
                size={14}
              />
              {scanning ? t("device.scanning") : t("device.scanNow")}
            </Button>
          </>
        }
        headerExtras={
          !online || listError ? (
            <>
              {!online ? (
                <p className="fdy-skill-offline" role="status">
                  {t("device.offline")}
                </p>
              ) : null}
              {listError ? (
                <p className="fdy-skill-error" role="alert">
                  <AlertTriangle size={13} /> {listError}
                </p>
              ) : null}
            </>
          ) : null
        }
        emptyState={{
          title: t("device.emptyTitle"),
          body: t("device.emptyBody"),
        }}
        mode="device"
        onStatusFilterChange={(v) => setServerFilter(v as SkillServerFilter)}
        renderActions={(skill) => {
          const raw = skill.deviceSkill;
          if (!raw) return null;
          const unreadable = raw.sizeBytes < 0;
          return (
            <>
              {raw.serverCandidates?.length ? (
                <Button
                  onClick={() =>
                    setComparison({
                      skill: raw,
                      target:
                        raw.serverCandidates!.find(
                          (c) => c.id === raw.promotedSkillId,
                        ) ?? raw.serverCandidates![0]!,
                    })
                  }
                  size="sm"
                  variant="secondary"
                >
                  {t("device.compare")}
                </Button>
              ) : null}
              <Button
                disabled={unreadable}
                onClick={() => setPromotion(raw)}
                size="sm"
                variant="secondary"
              >
                <UploadCloud size={14} />
                {t("device.reviewPromote")}
              </Button>
            </>
          );
        }}
        renderBadges={(skill) => {
          const raw = skill.deviceSkill;
          if (!raw) return null;
          return (raw.serverState && raw.serverState !== "unpublished") ||
            raw.promotedSkillId ? (
            <Badge
              tone={
                raw.serverState === "in_sync"
                  ? "online"
                  : raw.serverState === "different" ||
                      raw.serverState === "name_conflict"
                    ? "warn"
                    : "neutral"
              }
            >
              {skillServerLabel(raw)}
            </Badge>
          ) : null;
        }}
        searchPlaceholder={t("device.searchPlaceholder")}
        skills={normalizedSkills}
        statusFilterOptions={serverStatusOptions(t)}
        statusFilterPredicate={(skill, filterVal) => {
          const raw = skill.deviceSkill;
          if (!raw) return true;
          if (filterVal === "unpublished") return !raw.promotedSkillId;
          if (
            filterVal === "different" ||
            filterVal === "in_sync" ||
            filterVal === "unknown"
          ) {
            return raw.serverState === filterVal;
          }
          if (filterVal === "same_name") {
            return (
              raw.serverState === "name_conflict" ||
              raw.serverState === "reusable"
            );
          }
          return true;
        }}
        statusFilterValue={serverFilter}
        title={t("device.title")}
      />
    </div>
  );
}
