import type {
  BuiltinSkill,
  DeviceSkill,
  ProviderHealth,
} from "@bd777/foundry-protocol";
import { useTranslation } from "react-i18next";
import { FieldHint } from "../../components/ui/field";
import type { WorkspaceSkillSummary } from "../../api-types";
import { claudeSkillListing, type ListedSkill } from "./skill-listing-budget";

/** Foundry hands Claude Code its Skills as the plugin `foundry-workspace`. */
const pluginPrefix = "foundry-workspace:";

/**
 * The Skills a Claude Code session in this workspace lists: Foundry's (this
 * workspace's, connector bundles', built-in), Claude Code's own, and the
 * device's own folders it reads (~/.claude/skills and the workspace's
 * .claude/skills).
 */
export function claudeListedSkills({
  workspaceSkills,
  builtinSkills,
  providerHealth,
  deviceSkills,
  workspacePath,
}: {
  workspaceSkills: WorkspaceSkillSummary[];
  builtinSkills: BuiltinSkill[];
  providerHealth: ProviderHealth[];
  deviceSkills: DeviceSkill[];
  workspacePath?: string;
}): ListedSkill[] {
  const projectRoot = workspacePath
    ? `${workspacePath.replace(/\/+$/, "")}/.claude/skills`
    : undefined;
  return [
    ...workspaceSkills.map((skill) => ({
      name: pluginPrefix + skill.name,
      description: skill.description,
    })),
    ...builtinSkills
      .filter((skill) => skill.runtime === "claude")
      .map((skill) => ({
        name: pluginPrefix + skill.name,
        description: skill.description,
      })),
    ...providerHealth
      .filter((row) => row.provider === "claude")
      .flatMap((row) => row.officialSkills ?? [])
      .map((skill) => ({
        name: skill.name,
        description: skill.description,
        bundled: true,
      })),
    ...deviceSkills
      .filter((skill) => {
        const root = skill.root.replace(/\/+$/, "");
        return root === "~/.claude/skills" || root === projectRoot;
      })
      .map((skill) => ({ name: skill.name, description: skill.description })),
  ];
}

/** Says when a Claude Code session here lists Skills without descriptions. */
export function SkillListingNote({ skills }: { skills: ListedSkill[] }) {
  const { t } = useTranslation("skills");
  const estimate = claudeSkillListing(skills);
  if (estimate.withoutDescriptions === 0) return null;
  return (
    <FieldHint as="div" className="m-0" role="note" tone="warning">
      {t("workspace.listingBudget", {
        count: estimate.entries,
        without: estimate.withoutDescriptions,
        budget: estimate.budget.toLocaleString(),
      })}
    </FieldHint>
  );
}
