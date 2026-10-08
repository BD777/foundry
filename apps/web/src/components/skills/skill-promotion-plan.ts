import type { DeviceSkill, SkillDependency } from "@bd777/foundry-protocol";
import { i18n } from "../../i18n";

export interface SkillPromotionSelection {
  skills: DeviceSkill[];
  problems: string[];
  related: SkillDependency[];
}
const key = (skill: Pick<DeviceSkill, "root" | "dirName">) =>
  `${skill.root}\0${skill.dirName}`;

/** Resolve only the stored graph. Opening/toggling a preview does no I/O. */
export function buildSkillPromotionSelection(
  root: DeviceSkill,
  skills: DeviceSkill[],
  includeRelated: string[],
): SkillPromotionSelection {
  const byKey = new Map(skills.map((s) => [key(s), s]));
  const included = new Set(includeRelated);
  const visited = new Set<string>();
  const names = new Map<string, string>();
  const result: SkillPromotionSelection = {
    skills: [],
    problems: [],
    related: [],
  };
  const stack = [key(root)];
  while (stack.length) {
    const source = stack.pop()!;
    if (visited.has(source)) continue;
    visited.add(source);
    const skill = byKey.get(source);
    if (!skill) {
      result.problems.push(i18n.t("skills:plan.sourceMissing"));
      continue;
    }
    if (
      names.has(skill.name.toLowerCase()) &&
      names.get(skill.name.toLowerCase()) !== source
    ) {
      result.problems.push(
        i18n.t("skills:plan.conflictingVersions", { name: skill.name }),
      );
      continue;
    }
    names.set(skill.name.toLowerCase(), source);
    result.skills.push(skill);
    if (skill.dependencyAnalysisError)
      result.problems.push(
        i18n.t("skills:plan.analysisError", {
          name: skill.name,
          error: skill.dependencyAnalysisError,
        }),
      );
    else if (!skill.dependenciesAnalyzed || !skill.sourceDigest)
      result.problems.push(
        i18n.t("skills:plan.needsScan", { name: skill.name }),
      );
    if (skill.sizeBytes < 0 && !skill.dependencyAnalysisError)
      result.problems.push(
        i18n.t("skills:plan.unreadable", { name: skill.name }),
      );
    for (const dep of skill.dependencies ?? []) {
      if (dep.strength !== "required") result.related.push(dep);
      if (dep.strength !== "required" && !included.has(dep.skillName)) continue;
      if (dep.status !== "resolved" || !dep.targetRoot || !dep.targetDirName)
        result.problems.push(
          i18n.t("skills:plan.needsDependency", {
            name: skill.name,
            dependency: dep.skillName,
            status: i18n.t(
              `skills:dependencies.status.${dep.status ?? "unresolved"}`,
            ),
            evidence: dep.evidence,
          }),
        );
      else stack.push(`${dep.targetRoot}\0${dep.targetDirName}`);
    }
  }
  result.skills.sort((a, b) => key(a).localeCompare(key(b)));
  return result;
}

/** Only these exact source trees were shown in the local preview. */
export function sameSkillPromotionSources(
  a: DeviceSkill[],
  b: DeviceSkill[],
): boolean {
  const sources = (skills: DeviceSkill[]) =>
    skills.map((s) => `${key(s)}\0${s.sourceDigest}`).sort();
  return JSON.stringify(sources(a)) === JSON.stringify(sources(b));
}

/** Initial draft follows every reachable reference, including transitive ones.
 * A later user deselection is preserved until the dialog is opened again. */
export function defaultSkillPromotionReferences(
  root: DeviceSkill,
  skills: DeviceSkill[],
): string[] {
  const byKey = new Map(skills.map((s) => [key(s), s]));
  const visited = new Set<string>();
  const selected = new Set<string>();
  const stack = [key(root)];
  while (stack.length) {
    const source = stack.pop()!;
    if (visited.has(source)) continue;
    visited.add(source);
    for (const dep of byKey.get(source)?.dependencies ?? []) {
      if (dep.strength === "related") selected.add(dep.skillName);
      if (dep.status === "resolved" && dep.targetRoot && dep.targetDirName)
        stack.push(`${dep.targetRoot}\0${dep.targetDirName}`);
    }
  }
  return [...selected];
}
