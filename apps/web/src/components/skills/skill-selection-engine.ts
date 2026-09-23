import type { SkillDependency } from "@foundry/protocol";
import type { NormalizedSkill } from "./skill-models";

export interface MissingSkillDependency {
  sourceSkillName: string;
  missingSkillName: string;
  evidence: string;
}

export interface ResolvedSkillSelection {
  /** Complete set of skill IDs that should be enabled */
  selectedIds: Set<string>;
  /** Skill IDs that were enabled by dependency association, not directly clicked */
  autoActivatedIds: Set<string>;
  /** Map from target skill ID to list of skill names requiring it */
  requiredBy: Map<string, string[]>;
  /** Map from target skill ID to list of skill names relating to it */
  relatedTo: Map<string, string[]>;
  /** Missing required dependencies by source skill ID */
  missingRequired: Map<string, MissingSkillDependency[]>;
}

export interface SkillToggleResult {
  allowed: boolean;
  blockedReason?: string;
  nextExplicit: Set<string>;
  nextDeselectedRelated: Set<string>;
  resolution: ResolvedSkillSelection;
  newlyActivatedNames: string[];
}

/**
 * Builds lookup indexes for skills by id and lowercase name.
 */
function buildSkillIndexes(catalog: NormalizedSkill[]) {
  const byId = new Map<string, NormalizedSkill>();
  const byName = new Map<string, NormalizedSkill>();
  for (const skill of catalog) {
    byId.set(skill.id, skill);
    byName.set(skill.name.toLowerCase(), skill);
  }
  return { byId, byName };
}

/**
 * Resolves the full transitive closure of required and default-related skills.
 */
export function resolveSkillSelection(
  catalog: NormalizedSkill[],
  explicitlySelected: Set<string>,
  deselectedRelated: Set<string> = new Set(),
): ResolvedSkillSelection {
  const { byId, byName } = buildSkillIndexes(catalog);
  const selectedIds = new Set<string>();
  const autoActivatedIds = new Set<string>();
  const requiredBy = new Map<string, string[]>();
  const relatedTo = new Map<string, string[]>();
  const missingRequired = new Map<string, MissingSkillDependency[]>();

  // Queue of skill IDs to traverse: [skillId, isExplicitRoot]
  // We track visited nodes per path/closure to avoid infinite loops on cycles.
  const visitedRequired = new Set<string>();
  const visitedRelated = new Set<string>();

  // 1. First, process all explicitly selected skills
  for (const id of explicitlySelected) {
    const skill = byId.get(id);
    if (!skill) continue;
    selectedIds.add(id);
  }

  // 2. Transitive traversal starting from all currently selected skills
  // Stack contains [skillId, sourceName]
  const stack: Array<{ skillId: string; sourceSkill: NormalizedSkill }> = [];
  for (const id of explicitlySelected) {
    const skill = byId.get(id);
    if (skill) {
      stack.push({ skillId: id, sourceSkill: skill });
    }
  }

  while (stack.length > 0) {
    const { skillId, sourceSkill } = stack.pop()!;
    const skill = byId.get(skillId);
    if (!skill || !skill.dependencies) continue;

    for (const dep of skill.dependencies) {
      const depNameLower = dep.skillName.toLowerCase();
      const targetSkill = byName.get(depNameLower);

      if (dep.strength === "required") {
        if (!targetSkill) {
          // Missing required dependency
          const list = missingRequired.get(skill.id) ?? [];
          list.push({
            sourceSkillName: skill.name,
            missingSkillName: dep.skillName,
            evidence: dep.evidence,
          });
          missingRequired.set(skill.id, list);
          continue;
        }

        // Record requirement
        const reqList = requiredBy.get(targetSkill.id) ?? [];
        if (!reqList.includes(skill.name)) {
          reqList.push(skill.name);
          requiredBy.set(targetSkill.id, reqList);
        }

        selectedIds.add(targetSkill.id);
        if (!explicitlySelected.has(targetSkill.id)) {
          autoActivatedIds.add(targetSkill.id);
        }

        // If we haven't traversed this required target yet, push to stack
        if (!visitedRequired.has(targetSkill.id)) {
          visitedRequired.add(targetSkill.id);
          stack.push({ skillId: targetSkill.id, sourceSkill: skill });
        }
      } else if (dep.strength === "related") {
        if (!targetSkill) continue;

        // Record relation
        const relList = relatedTo.get(targetSkill.id) ?? [];
        if (!relList.includes(skill.name)) {
          relList.push(skill.name);
          relatedTo.set(targetSkill.id, relList);
        }

        // Related dependencies are default-enabled unless user explicitly opted out
        if (!deselectedRelated.has(targetSkill.id)) {
          selectedIds.add(targetSkill.id);
          if (!explicitlySelected.has(targetSkill.id)) {
            autoActivatedIds.add(targetSkill.id);
          }

          // Also traverse the dependencies of this auto-enabled related skill
          if (!visitedRelated.has(targetSkill.id)) {
            visitedRelated.add(targetSkill.id);
            stack.push({ skillId: targetSkill.id, sourceSkill: skill });
          }
        }
      }
    }
  }

  return {
    selectedIds,
    autoActivatedIds,
    requiredBy,
    relatedTo,
    missingRequired,
  };
}

/**
 * Handles toggling a skill on or off, returning the next state and resolution.
 */
export function toggleSkillSelection(
  targetSkillId: string,
  catalog: NormalizedSkill[],
  currentExplicit: Set<string>,
  currentDeselectedRelated: Set<string>,
): SkillToggleResult {
  const { byId } = buildSkillIndexes(catalog);
  const targetSkill = byId.get(targetSkillId);
  const currentResolution = resolveSkillSelection(
    catalog,
    currentExplicit,
    currentDeselectedRelated,
  );

  const isCurrentlySelected = currentResolution.selectedIds.has(targetSkillId);

  if (!isCurrentlySelected) {
    // === TOGGLE ON ===
    const nextExplicit = new Set(currentExplicit);
    const nextDeselectedRelated = new Set(currentDeselectedRelated);

    nextExplicit.add(targetSkillId);
    nextDeselectedRelated.delete(targetSkillId);

    const nextResolution = resolveSkillSelection(
      catalog,
      nextExplicit,
      nextDeselectedRelated,
    );

    // Identify newly auto-activated skills
    const newlyActivatedNames: string[] = [];
    for (const id of nextResolution.autoActivatedIds) {
      if (!currentResolution.selectedIds.has(id)) {
        const s = byId.get(id);
        if (s) newlyActivatedNames.push(s.name);
      }
    }

    return {
      allowed: true,
      nextExplicit,
      nextDeselectedRelated,
      resolution: nextResolution,
      newlyActivatedNames,
    };
  } else {
    // === TOGGLE OFF ===
    // Check if another active skill strictly requires this one
    const requirers = currentResolution.requiredBy.get(targetSkillId) ?? [];
    // Only requirers that are actually still in selectedIds count
    const activeRequirers = requirers.filter((name) => {
      const s = catalog.find((item) => item.name === name);
      return s && currentResolution.selectedIds.has(s.id);
    });

    if (activeRequirers.length > 0) {
      return {
        allowed: false,
        blockedReason: `${targetSkill?.name ?? "This skill"} is required by ${activeRequirers.join(", ")} and cannot be disabled.`,
        nextExplicit: currentExplicit,
        nextDeselectedRelated: currentDeselectedRelated,
        resolution: currentResolution,
        newlyActivatedNames: [],
      };
    }

    const nextExplicit = new Set(currentExplicit);
    const nextDeselectedRelated = new Set(currentDeselectedRelated);

    if (nextExplicit.has(targetSkillId)) {
      nextExplicit.delete(targetSkillId);
    } else {
      // It was an auto-activated related skill; user explicitly unchecks it
      nextDeselectedRelated.add(targetSkillId);
    }

    const nextResolution = resolveSkillSelection(
      catalog,
      nextExplicit,
      nextDeselectedRelated,
    );

    return {
      allowed: true,
      nextExplicit,
      nextDeselectedRelated,
      resolution: nextResolution,
      newlyActivatedNames: [],
    };
  }
}
