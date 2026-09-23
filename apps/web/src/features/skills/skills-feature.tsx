import { useMemo, useState } from "react";
import { ArrowRight, AlertTriangle, CheckCircle2 } from "lucide-react";
import type {
  DeviceProjection,
  DeviceSkill,
  PromotedSkill,
  WorkspaceSkillBinding,
} from "@foundry/protocol";
import { setWorkspaceSkills } from "../../api";
import { Button } from "../../components/ui/button";
import { PageSurface } from "../../components/ui/page-surface";
import { SkillCatalogList } from "../../components/skills/skill-catalog-list";
import {
  toNormalizedPromotedSkill,
  type NormalizedSkill,
} from "../../components/skills/skill-models";
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
  workspaceId: string;
  /** Why the caller cannot change this workspace's skill selection. */
  readOnlyReason?: string;
  onEvent?: (event: SkillsFeatureEvent) => void;
  onChanged?: () => Promise<void>;
}

const STATUS_FILTER_OPTIONS = [
  { value: "all", label: "All skills" },
  { value: "selected", label: "Selected in workspace" },
  { value: "unselected", label: "Not selected" },
];

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
  workspaceId,
  readOnlyReason,
  embedded,
  onChanged,
}: SkillsFeatureProps) {
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

  async function save(): Promise<void> {
    if (duplicateNames.length) return;
    setSaving(true);
    setError(undefined);
    try {
      await setWorkspaceSkills(workspaceId, [...resolution.selectedIds]);
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
        `Auto-enabled related skills: ${result.newlyActivatedNames.join(", ")}`,
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
            aria-label="Dismiss notice"
            onClick={() => setNotice(undefined)}
            size="sm"
            variant="ghost"
          >
            Dismiss
          </Button>
        </p>
      ) : null}

      <SkillCatalogList
        activeSkillNames={activeSkillNames}
        description="Only selected skills are exposed to this workspace's Chats and Issues. Skills are promoted from a device's Settings → Skills tab; personal skills on any machine are never exposed unless promoted and selected here."
        emptyState={{
          title: "No skills on the server yet",
          body: "Promote a local skill from a device's Skills tab, then select it here.",
          action: (
            <Button
              onClick={() => onEvent?.({ type: "manage-devices.requested" })}
            >
              Go to Devices
              <ArrowRight size={14} />
            </Button>
          ),
        }}
        footerActions={
          catalog.length > 0 ? (
            <>
              {duplicateNames.length ? (
                <p className="fdy-skill-error" role="alert">
                  Choose only one server entry for each invocation name:{" "}
                  {duplicateNames.join(", ")}.
                </p>
              ) : null}
              {readOnlyReason ? <p role="note">{readOnlyReason}</p> : null}
              <div className="fdy-workspace-skills-actions">
                <span className="fdy-workspace-skills-count">
                  {resolution.selectedIds.size} selected
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
                  {saving ? "Saving…" : "Save selection"}
                </Button>
              </div>
            </>
          ) : null
        }
        missingRequiredMap={resolution.missingRequired}
        mode="workspace"
        onStatusFilterChange={setStatusFilter}
        onToggleSelect={handleToggle}
        relatedToMap={resolution.relatedTo}
        requiredByMap={resolution.requiredBy}
        searchPlaceholder="Filter skills by name or description"
        selectedIds={resolution.selectedIds}
        skills={normalizedSkills}
        statusFilterOptions={STATUS_FILTER_OPTIONS}
        statusFilterPredicate={(skill, filterVal) => {
          if (filterVal === "selected")
            return resolution.selectedIds.has(skill.id);
          if (filterVal === "unselected")
            return !resolution.selectedIds.has(skill.id);
          return true;
        }}
        statusFilterValue={statusFilter}
        title="Skills available to this workspace"
      />
    </PageSurface>
  );
}
