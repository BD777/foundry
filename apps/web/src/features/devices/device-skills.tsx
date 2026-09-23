import { skillServerLabel } from "./skill-version-state";
import { type SkillServerFilter } from "./skill-search";
import { SkillPromotionDialog } from "./skill-promotion-dialog";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
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
} from "@foundry/protocol";
import { scanDeviceSkills, setDeviceSkillRoots } from "../../api";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { TextInput } from "../../components/ui/field";
import { SkillCatalogList } from "../../components/skills/skill-catalog-list";
import {
  toNormalizedDeviceSkill,
  type NormalizedSkill,
} from "../../components/skills/skill-models";

const SkillCompareDialog = lazy(() => import("./skill-compare-dialog"));

interface DeviceSkillsProps {
  device: DeviceProjection;
  roots: DeviceSkillRoot[];
  skills: DeviceSkill[];
  onChanged: () => Promise<void>;
}

const SERVER_STATUS_OPTIONS = [
  { value: "all", label: "All server states" },
  { value: "unpublished", label: "Not on server only" },
  { value: "different", label: "Local differs" },
  { value: "same_name", label: "Same-name entries" },
  { value: "in_sync", label: "In sync" },
  { value: "unknown", label: "Comparison unavailable" },
];

/**
 * Device-local skills: maintain scan roots, scan the machine, and promote
 * entries into the server catalog. Promotion is the only way a local skill
 * reaches a workspace — selection itself lives in the workspace Skills tab.
 */
export function DeviceSkills({
  device,
  roots,
  skills,
  onChanged,
}: DeviceSkillsProps) {
  const [draftPaths, setDraftPaths] = useState<string[]>([]);
  const [draftDirty, setDraftDirty] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [rootsBusy, setRootsBusy] = useState(false);
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
    return skills.map(toNormalizedDeviceSkill);
  }, [skills]);

  async function saveRoots(): Promise<void> {
    setRootsBusy(true);
    try {
      await setDeviceSkillRoots(device.id, draftPaths);
      setDraftDirty(false);
      await onChanged();
      if (online) await runScan();
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

  if (!loaded) return null;

  return (
    <div className="fdy-device-skills">
      {comparison ? (
        <Suspense fallback={<p role="status">Loading comparison…</p>}>
          <SkillCompareDialog
            onClose={() => setComparison(undefined)}
            skill={comparison.skill}
            target={comparison.target}
          />
        </Suspense>
      ) : null}
      {promotion ? (
        <SkillPromotionDialog
          onChanged={onChanged}
          onClose={() => setPromotion(undefined)}
          online={online}
          skill={promotion}
          skills={skills}
        />
      ) : null}
      <section className="fdy-skill-roots">
        <header>
          <h2>Scan directories</h2>
          <p>
            Folders this device scans for local skills. Defaults cover Claude
            Code and Codex. Add a folder to expose other skill locations.
          </p>
        </header>
        <ul>
          {draftPaths.map((path, index) => (
            <li className="fdy-skill-root-row" key={`${path}-${index}`}>
              <span className="fdy-skill-root-path" title={path}>
                {path}
              </span>
              {roots[index]?.isDefault ? (
                <Badge tone="neutral">Default</Badge>
              ) : null}
              <Button
                aria-label={`Remove ${path}`}
                disabled={rootsBusy}
                onClick={() => {
                  setDraftPaths((rows) => rows.filter((_, i) => i !== index));
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
            aria-label="Add skill directory"
            onChange={(event) => setNewPath(event.target.value)}
            placeholder="~/work/team-skills or /opt/skills"
            tone="boxed"
            value={newPath}
          />
          <Button
            disabled={!newPath.trim()}
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
            Add
          </Button>
        </div>
        <div className="fdy-skill-root-actions">
          <Button disabled={!draftDirty || rootsBusy} onClick={saveRoots}>
            Save directories
          </Button>
          <Button
            disabled={!online || scanning}
            onClick={runScan}
            variant="ghost"
          >
            <RefreshCw
              className={scanning ? "fdy-spin" : undefined}
              size={14}
            />
            {scanning ? "Scanning…" : "Scan now"}
          </Button>
        </div>
        {!online ? (
          <p className="fdy-skill-offline" role="status">
            Device offline. Connect it to scan or promote local skills.
          </p>
        ) : null}
        {scanError ? (
          <p className="fdy-skill-error" role="alert">
            <AlertTriangle size={13} /> {scanError}
          </p>
        ) : null}
      </section>

      <SkillCatalogList<NormalizedSkill>
        description="Promote one to publish it to the server catalog so a workspace can use it. Server status reflects the last device scan."
        emptyState={{
          title: "No local skills scanned yet",
          body: "Connect the device and run a scan to list its skills.",
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
                  variant="ghost"
                >
                  Compare
                </Button>
              ) : null}
              <Button
                disabled={unreadable}
                onClick={() => setPromotion(raw)}
                size="sm"
                variant="secondary"
              >
                <UploadCloud size={14} />
                Review & promote
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
        searchPlaceholder="Filter local skills by name or description"
        skills={normalizedSkills}
        statusFilterOptions={SERVER_STATUS_OPTIONS}
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
        title="Local skills"
      />
    </div>
  );
}
