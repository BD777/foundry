import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, AlertTriangle, CheckCircle2 } from "lucide-react";
import type {
  DeviceProjection,
  DeviceSkill,
  PromotedSkill,
  ProviderHealth,
  WorkspaceSkillBinding,
} from "@bd777/foundry-protocol";
import { setWorkspaceSkills } from "../../api";
import { Button } from "../../components/ui/button";
import { PageSurface } from "../../components/ui/page-surface";
import { SkillCatalogList } from "../../components/skills/skill-catalog-list";
import {
  toNormalizedPromotedSkill,
  type NormalizedSkill,
} from "../../components/skills/skill-models";
import { LocalSkillsSection, localOnlySkills } from "./local-skills-section";
import { OfficialSkillsSection } from "./official-skills-section";
import {
  resolveSkillSelection,
  toggleSkillSelection,
} from "../../components/skills/skill-selection-engine";

export type SkillsFeatureEvent =
  | { type: "manage-devices.requested" }
  | { message: string; type: "notice.requested" };

export interface SkillsFeatureProps {
  embedded?: boolean;
  catalog: PromotedSkill[];
  bindings: WorkspaceSkillBinding[];
  devices: DeviceProjection[];
  deviceSkills?: DeviceSkill[];
  /** The workspace device's Claude Code / Codex, with their own skills. */
  providerHealth?: ProviderHealth[];
  workspaceId: string;
  /** The device this workspace runs on; its local skills can be added here. */
  workspaceDeviceId?: string;
  /** Why the caller cannot change this workspace's skill selection. */
  readOnlyReason?: string;
  onEvent?: (event: SkillsFeatureEvent) => void;
  onChanged?: () => Promise<void>;
}

/**
 * Workspace skill selection. The catalog is server-owned (entries arrive via
 * device promotion); this view chooses which entries the workspace exposes
 * to its Chats and Issues runs, automatically activating required and related
 * dependencies by default.
 */
export function SkillsFeature({
  onEvent,
  catalog,
  bindings,
  devices,
  deviceSkills,
  providerHealth,
  workspaceId,
  workspaceDeviceId,
  readOnlyReason,
  embedded,
  onChanged,
}: SkillsFeatureProps) {
  const { t } = useTranslation(["skills", "common"]);
  const statusFilterOptions = [
    { value: "all", label: t("workspace.filterAll") },
    { value: "selected", label: t("workspace.filterSelected") },
    { value: "unselected", label: t("workspace.filterUnselected") },
  ];
  const initial = useMemo(
    () => new Set(bindings.map((binding) => binding.skillId)),
    [bindings],
  );

  const [explicitlySelected, setExplicitlySelected] =
    useState<Set<string>>(initial);
  const [deselectedRelated, setDeselectedRelated] = useState<Set<string>>(
    new Set(),
  );
  const [statusFilter, setStatusFilter] = useState("all");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const deviceLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const device of devices) labels.set(device.id, device.label);
    return labels;
  }, [devices]);

  const normalizedSkills = useMemo(() => {
    return catalog.map((s) =>
      toNormalizedPromotedSkill(s, deviceLabels, deviceSkills),
    );
  }, [catalog, deviceLabels, deviceSkills]);

  const resolution = useMemo(() => {
    return resolveSkillSelection(
      normalizedSkills,
      explicitlySelected,
      deselectedRelated,
    );
  }, [normalizedSkills, explicitlySelected, deselectedRelated]);

  const activeSkillNames = useMemo(() => {
    const names = new Set<string>();
    for (const id of resolution.selectedIds) {
      const s = normalizedSkills.find((item) => item.id === id);
      if (s) names.add(s.name.toLowerCase());
    }
    return names;
  }, [normalizedSkills, resolution.selectedIds]);

  const dirty =
    resolution.selectedIds.size !== initial.size ||
    [...resolution.selectedIds].some((id) => !initial.has(id));

  const duplicateNames = useMemo(() => {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const skill of catalog) {
      if (resolution.selectedIds.has(skill.id)) {
        const lower = skill.name.toLowerCase();
        if (seen.has(lower)) duplicates.add(skill.name);
        seen.add(lower);
      }
    }
    return [...duplicates];
  }, [catalog, resolution.selectedIds]);

  // A skill added from the workspace's device is selected once it is in the
  // catalog (see LocalSkillsSection).
  const workspaceDevice = devices.find((d) => d.id === workspaceDeviceId);
  const [pendingSelect, setPendingSelect] = useState<string>();
  useEffect(() => {
    if (!pendingSelect || !normalizedSkills.some((s) => s.id === pendingSelect))
      return;
    setPendingSelect(undefined);
    if (resolution.selectedIds.has(pendingSelect)) return;
    const result = toggleSkillSelection(
      pendingSelect,
      normalizedSkills,
      explicitlySelected,
      deselectedRelated,
    );
    if (!result.allowed) {
      setError(result.blockedReason);
      return;
    }
    setExplicitlySelected(result.nextExplicit);
    setDeselectedRelated(result.nextDeselectedRelated);
    void persist(
      resolveSkillSelection(
        normalizedSkills,
        result.nextExplicit,
        result.nextDeselectedRelated,
      ).selectedIds,
    );
  }, [
    pendingSelect,
    normalizedSkills,
    resolution.selectedIds,
    explicitlySelected,
    deselectedRelated,
  ]);

  async function save(): Promise<void> {
    if (duplicateNames.length) return;
    await persist(resolution.selectedIds);
  }

  async function persist(selectedIds: Set<string>): Promise<void> {
    setSaving(true);
    setError(undefined);
    try {
      await setWorkspaceSkills(workspaceId, [...selectedIds]);
      await onChanged?.();
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : String(saveError),
      );
    } finally {
      setSaving(false);
    }
  }

  function handleToggle(skill: NormalizedSkill): void {
    if (readOnlyReason) return;
    setError(undefined);
    const result = toggleSkillSelection(
      skill.id,
      normalizedSkills,
      explicitlySelected,
      deselectedRelated,
    );

    if (!result.allowed) {
      setError(result.blockedReason);
      return;
    }

    setExplicitlySelected(result.nextExplicit);
    setDeselectedRelated(result.nextDeselectedRelated);

    if (result.newlyActivatedNames.length > 0) {
      setNotice(
        t("workspace.autoEnabled", {
          names: result.newlyActivatedNames.join(", "),
        }),
      );
    }
  }

  return (
    <PageSurface embedded={embedded} variant="skills">
      {error ? (
        <p className="fdy-skill-error" role="alert">
          <AlertTriangle size={13} /> {error}
        </p>
      ) : null}

      {notice ? (
        <p className="fdy-skill-notice" role="status">
          <CheckCircle2 size={14} />
          <span>{notice}</span>
          <Button
            aria-label={t("workspace.dismissNotice")}
            onClick={() => setNotice(undefined)}
            size="sm"
            variant="ghost"
          >
            {t("workspace.dismiss")}
          </Button>
        </p>
      ) : null}

      <OfficialSkillsSection providerHealth={providerHealth ?? []} />

      <SkillCatalogList
        activeSkillNames={activeSkillNames}
        emptyState={{
          title: t("workspace.emptyTitle"),
          body: t("workspace.emptyBody"),
          // With skills to add from this workspace's device right below,
          // sending people to Devices would be a detour.
          action:
            workspaceDeviceId &&
            localOnlySkills(deviceSkills ?? [], workspaceDeviceId)
              .length ? undefined : (
              <Button
                onClick={() => onEvent?.({ type: "manage-devices.requested" })}
              >
                {t("workspace.goToDevices")}
                <ArrowRight size={14} />
              </Button>
            ),
        }}
        headerActions={
          catalog.length > 0 ? (
            <>
              <span className="fdy-workspace-skills-count">
                {t("workspace.selectedCount", {
                  count: resolution.selectedIds.size,
                })}
              </span>
              <Button
                disabled={
                  !dirty ||
                  saving ||
                  !!duplicateNames.length ||
                  !!readOnlyReason
                }
                onClick={save}
              >
                {saving
                  ? t("common:actions.saving")
                  : t("workspace.saveSelection")}
              </Button>
            </>
          ) : null
        }
        headerExtras={
          catalog.length > 0 && (duplicateNames.length || readOnlyReason) ? (
            <>
              {duplicateNames.length ? (
                <p className="fdy-skill-error" role="alert">
                  {t("workspace.duplicateNames", {
                    names: duplicateNames.join(", "),
                  })}
                </p>
              ) : null}
              {readOnlyReason ? <p role="note">{readOnlyReason}</p> : null}
            </>
          ) : null
        }
        missingRequiredMap={resolution.missingRequired}
        mode="workspace"
        onStatusFilterChange={setStatusFilter}
        onToggleSelect={handleToggle}
        relatedToMap={resolution.relatedTo}
        requiredByMap={resolution.requiredBy}
        searchPlaceholder={t("workspace.searchPlaceholder")}
        selectedIds={resolution.selectedIds}
        skills={normalizedSkills}
        statusFilterOptions={statusFilterOptions}
        statusFilterPredicate={(skill, filterVal) => {
          if (filterVal === "selected")
            return resolution.selectedIds.has(skill.id);
          if (filterVal === "unselected")
            return !resolution.selectedIds.has(skill.id);
          return true;
        }}
        statusFilterValue={statusFilter}
        title={t("workspace.title")}
      />

      {workspaceDevice ? (
        <LocalSkillsSection
          device={workspaceDevice}
          deviceSkills={deviceSkills ?? []}
          readOnly={!!readOnlyReason}
          onChanged={async () => {
            await onChanged?.();
          }}
          onPromoted={(id) => setPendingSelect(id)}
        />
      ) : null}
    </PageSurface>
  );
}
