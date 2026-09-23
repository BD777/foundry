import type {
  DeviceSkill,
  PromotedSkill,
  SkillDependency,
} from "@foundry/protocol";

export interface NormalizedSkill {
  id: string;
  name: string;
  description: string;
  subtitle: string;
  path: string;
  sizeBytes?: number;
  dependencies?: SkillDependency[];
  dependencyAnalysisError?: string;
  kind: "device" | "promoted";
  deviceSkill?: DeviceSkill;
  promotedSkill?: PromotedSkill;
}

function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function toNormalizedDeviceSkill(skill: DeviceSkill): NormalizedSkill {
  const key = `${skill.root}\0${skill.dirName}`;
  const dirPath =
    skill.dirName === skill.name
      ? skill.root
      : `${skill.dirName} · ${skill.root}`;
  return {
    id: key,
    name: skill.name,
    description: skill.description,
    subtitle: `${dirPath} · ${formatBytes(skill.sizeBytes)}`,
    path: skill.root,
    sizeBytes: skill.sizeBytes,
    dependencies: skill.dependencies,
    dependencyAnalysisError: skill.dependencyAnalysisError,
    kind: "device",
    deviceSkill: skill,
  };
}

export function toNormalizedPromotedSkill(
  skill: PromotedSkill,
  deviceLabels: Map<string, string>,
  deviceSkills?: DeviceSkill[],
): NormalizedSkill {
  const originDevice =
    deviceLabels.get(skill.originDeviceId) ??
    skill.originDeviceLabel ??
    "another device";
  const subtitle = `From ${originDevice} · rev ${skill.latestRevision} · ${skill.originRoot || "promoted skill"}`;

  // Fallback to client-loaded deviceSkills if server catalog hasn't populated dependencies yet
  let dependencies = skill.dependencies;
  let dependencyAnalysisError = skill.dependencyAnalysisError;
  if (!dependencies && deviceSkills) {
    const match = deviceSkills.find(
      (ds) =>
        ds.promotedSkillId === skill.id ||
        (ds.deviceId === skill.originDeviceId &&
          ds.root === skill.originRoot &&
          ds.dirName === skill.originDirName),
    );
    if (match) {
      dependencies = match.dependencies;
      dependencyAnalysisError = match.dependencyAnalysisError;
    }
  }

  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    subtitle,
    path: skill.originRoot,
    dependencies,
    dependencyAnalysisError,
    kind: "promoted",
    promotedSkill: skill,
  };
}
