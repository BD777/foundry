import { useTranslation } from "react-i18next";
import type { BuiltinSkill, ProviderHealth } from "@bd777/foundry-protocol";
import { Badge } from "../../components/ui/badge";

// i18n-ignore: runtime product names
const agentNames = { claude: "Claude Code", codex: "Codex" } as const;

/**
 * Marks a workspace skill that shares its name with one of Foundry's built-in
 * skills: one invocation name means one skill, so sessions on that agent use
 * the built-in instead.
 */
export function BuiltinShadowBadge({
  name,
  builtinSkills,
}: {
  name: string;
  builtinSkills?: BuiltinSkill[];
}) {
  const { t } = useTranslation("skills");
  const builtin = builtinSkills?.find(
    (item) => item.name.toLowerCase() === name.toLowerCase(),
  );
  if (!builtin) return null;
  return (
    <Badge tone="warn">
      {t("workspace.shadowedByBuiltin", {
        agent: agentNames[builtin.runtime],
        name: builtin.name,
      })}
    </Badge>
  );
}

/**
 * Marks a workspace skill that shares its name with a skill an agent ships:
 * sessions on that agent use the workspace skill instead.
 */
export function ReplacesOfficialBadge({
  name,
  providerHealth,
}: {
  name: string;
  providerHealth?: ProviderHealth[];
}) {
  const { t } = useTranslation("skills");
  const agents = (providerHealth ?? [])
    .filter((row) =>
      row.officialSkills?.some(
        (skill) => skill.name.toLowerCase() === name.toLowerCase(),
      ),
    )
    .map((row) => agentNames[row.provider]);
  if (!agents.length) return null;
  return (
    <Badge tone="neutral">
      {t("workspace.replacesOfficial", { agents: agents.join(", "), name })}
    </Badge>
  );
}
