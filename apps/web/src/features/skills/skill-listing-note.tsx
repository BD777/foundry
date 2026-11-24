import type { BuiltinSkill, ProviderHealth } from "@bd777/foundry-protocol";
import { useTranslation } from "react-i18next";
import { FieldHint } from "../../components/ui/field";
import type { WorkspaceSkillSummary } from "../../api-types";
import { claudeSkillListing, type ListedSkill } from "./skill-listing-budget";

/** Foundry hands Claude Code its Skills as the plugin `foundry-workspace`. */
const pluginPrefix = "foundry-workspace:";

/** The server projection includes selected library skills and ready workspace drafts. */
export function claudeListedSkills({
  workspaceSkills,
  builtinSkills,
  providerHealth,
}: {
  workspaceSkills: WorkspaceSkillSummary[];
  builtinSkills: BuiltinSkill[];
  providerHealth: ProviderHealth[];
}): ListedSkill[] {
  const builtinNames = new Set(
    builtinSkills
      .filter((s) => s.runtime === "claude")
      .map((s) => s.name.toLowerCase()),
  );
  return [
    ...workspaceSkills
      .filter((s) => !builtinNames.has(s.name.toLowerCase()))
      .map((skill) => ({
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
