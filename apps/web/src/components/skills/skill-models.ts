import type {
  DeviceSkill,
  PromotedSkill,
  SkillDependency,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { i18n } from "../../i18n";

export interface NormalizedSkill {
  id: string;
  name: string;
  description: string;
  subtitle: string;
  path: string;
  sizeBytes?: number;
  dependencies?: SkillDependency[];
  dependencyAnalysisError?: string;
  /** Programs the skill runs. */
  requires?: string[];
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

/**
 * The workspace whose own skill folder (e.g. `<workspace>/.claude/skills`) a
 * device skill sits in: a draft made or changed in that workspace.
 */
export function skillWorkspace(
  skill: DeviceSkill,
  workspaces: WorkspaceProjection[],
): WorkspaceProjection | undefined {
  return workspaces.find((workspace) => {
    const base = workspace.localPath?.replace(/\/+$/, "");
    return (
      workspace.deviceId === skill.deviceId &&
      Boolean(base) &&
      skill.root.startsWith(`${base}/`)
    );
  });
}

export function toNormalizedDeviceSkill(
  skill: DeviceSkill,
  workspace?: WorkspaceProjection,
): NormalizedSkill {
  const key = `${skill.root}\0${skill.dirName}`;
  const root = workspace
    ? `${workspace.name} · ${skill.root.slice(workspace.localPath.replace(/\/+$/, "").length + 1)}`
    : skill.root;
  const dirPath =
    skill.dirName === skill.name ? root : `${skill.dirName} · ${root}`;
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
    i18n.t("skills:models.anotherDevice");
  // Skills from a git repository: the origin root is the repository and the
  // origin folder the skill's folder in it.
  const subtitle = skill.originDeviceId.startsWith("repo:")
    ? i18n.t("skills:models.repositorySubtitle", {
        repository: skill.originRoot,
        revision: skill.latestRevision,
        dir: skill.originDirName,
      })
    : i18n.t("skills:models.promotedSubtitle", {
        device: originDevice,
        revision: skill.latestRevision,
        root: skill.originRoot || i18n.t("skills:models.promotedSkill"),
      });

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
    requires: skill.requires,
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
