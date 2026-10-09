import { useEffect, useMemo, useState } from "react";
import type { TFunction } from "i18next";
import type {
  DeviceProjection,
  DeviceSkill,
  PromotedSkill,
  WorkspaceSkillBinding,
} from "@bd777/foundry-protocol";
import { setWorkspaceSkills } from "../../api";
import {
  toNormalizedPromotedSkill,
  type NormalizedSkill,
} from "../../components/skills/skill-models";
import {
  resolveSkillSelection,
  toggleSkillSelection,
} from "../../components/skills/skill-selection-engine";

/**
 * A workspace's skill selection: what is chosen, what that pulls in, which
 * skills it gets from defaults or bundles but turned off, and saving it. A
 * skill just added from the workspace's device is selected as soon as it
 * reaches the catalog.
 */
export function useWorkspaceSkillSelection({
  catalog,
  bindings,
  devices,
  deviceSkills,
  inheritedSkillIds,
  offSkillIds,
  workspaceId,
  readOnlyReason,
  onChanged,
  t,
}: {
  catalog: PromotedSkill[];
  bindings: WorkspaceSkillBinding[];
  devices: DeviceProjection[];
  deviceSkills?: DeviceSkill[];
  /** Skills the workspace gets from defaults or bundles, and those it turned off. */
  inheritedSkillIds?: string[];
  offSkillIds?: string[];
  workspaceId: string;
  readOnlyReason?: string;
  onChanged?: () => Promise<void>;
  t: TFunction<["skills", "common"]>;
}) {
  const initial = useMemo(
    () => new Set(bindings.map((binding) => binding.skillId)),
    [bindings],
  );

  const [explicitlySelected, setExplicitlySelected] =
    useState<Set<string>>(initial);
  const inherited = useMemo(
    () => new Set(inheritedSkillIds ?? []),
    [inheritedSkillIds],
  );
  const initialOff = useMemo(() => new Set(offSkillIds ?? []), [offSkillIds]);
  const [off, setOff] = useState<Set<string>>(initialOff);
  const [deselectedRelated, setDeselectedRelated] = useState<Set<string>>(
    new Set(),
  );
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

  // On: selected, or inherited and not turned off.
  const onIds = useMemo(() => {
    const ids = new Set(resolution.selectedIds);
    for (const id of inherited) if (!off.has(id)) ids.add(id);
    return ids;
  }, [resolution.selectedIds, inherited, off]);

  const dirty =
    !sameSet(resolution.selectedIds, initial) || !sameSet(off, initialOff);

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
      off,
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
    await persist(resolution.selectedIds, off);
  }

  async function persist(
    selectedIds: Set<string>,
    offIds: Set<string>,
  ): Promise<void> {
    setSaving(true);
    setError(undefined);
    try {
      await setWorkspaceSkills(workspaceId, [...selectedIds], [...offIds]);
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
    // An inherited skill turns off or back on here; unchecking it also
    // drops it from the selection so it really goes off.
    if (inherited.has(skill.id)) {
      const nextOff = new Set(off);
      if (onIds.has(skill.id)) {
        nextOff.add(skill.id);
        if (explicitlySelected.has(skill.id)) {
          const nextExplicit = new Set(explicitlySelected);
          nextExplicit.delete(skill.id);
          setExplicitlySelected(nextExplicit);
        }
      } else nextOff.delete(skill.id);
      setOff(nextOff);
      return;
    }
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

  return {
    normalizedSkills,
    resolution,
    onIds,
    activeSkillNames,
    dirty,
    duplicateNames,
    saving,
    error,
    setError,
    notice,
    setNotice,
    save,
    handleToggle,
    selectAfterPublish: setPendingSelect,
  };
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}
