import { toast } from "../../components/ui/toast";
import { useEffect, useMemo, useRef, useState } from "react";
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
 * skills it gets from defaults or bundles but turned off, and saving it.
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
  // Publishing can select skills on the server while unrelated checkboxes have
  // unsaved edits. Apply just the changed bindings to the current form.
  const previous = useRef({ initial, initialOff, workspaceId });
  useEffect(() => {
    const before = previous.current;
    previous.current = { initial, initialOff, workspaceId };
    if (before.workspaceId !== workspaceId) {
      setExplicitlySelected(initial);
      setOff(initialOff);
      setDeselectedRelated(new Set());
      return;
    }
    if (!sameSet(before.initial, initial))
      setExplicitlySelected((current) =>
        mergeBindingChanges(current, before.initial, initial),
      );
    if (!sameSet(before.initialOff, initialOff))
      setOff((current) =>
        mergeBindingChanges(current, before.initialOff, initialOff),
      );
  }, [initial, initialOff, workspaceId]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

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
      toast({
        tone: "error",
        title:
          saveError instanceof Error ? saveError.message : String(saveError),
      });
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
    autoEnabledNames: normalizedSkills
      .filter(
        (skill) =>
          resolution.autoActivatedIds.has(skill.id) && !initial.has(skill.id),
      )
      .map((skill) => skill.name),
    save,
    handleToggle,
  };
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

function mergeBindingChanges(
  current: Set<string>,
  before: Set<string>,
  after: Set<string>,
) {
  const next = new Set(current);
  for (const id of before) if (!after.has(id)) next.delete(id);
  for (const id of after) if (!before.has(id)) next.add(id);
  return next;
}
