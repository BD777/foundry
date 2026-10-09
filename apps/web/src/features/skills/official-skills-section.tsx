import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import type { BuiltinSkill, ProviderHealth } from "@bd777/foundry-protocol";
import { RuntimeMark } from "../../components/ui/runtime-mark";

// i18n-ignore: runtime product names
const agentNames = { claude: "Claude Code", codex: "Codex" } as const;

/**
 * The skills each agent always has: the ones Claude Code and Codex ship, as
 * read on the workspace's device, and the ones Foundry adds for that agent.
 * One collapsed row per agent, since they are not chosen here.
 */
export function OfficialSkillsSection({
  providerHealth,
  builtinSkills,
}: {
  providerHealth: ProviderHealth[];
  builtinSkills: BuiltinSkill[];
}) {
  const { t } = useTranslation("skills");
  const agents = providerHealth
    .map((row) => ({
      provider: row.provider,
      skills: [
        ...(row.officialSkills ?? []).map((skill) => ({
          ...skill,
          source: undefined as string | undefined,
        })),
        ...builtinSkills
          .filter((skill) => skill.runtime === row.provider)
          .map((skill) => ({
            name: skill.name,
            description: skill.description,
            source: skill.source,
          })),
      ],
    }))
    .filter((row) => row.skills.length);
  if (!agents.length) return null;
  return (
    <section className="fdy-official-skills">
      <header className="fdy-skill-catalog-heading">
        <div className="fdy-skill-catalog-heading-copy">
          <h2>{t("workspace.officialTitle")}</h2>
          <p>{t("workspace.officialDescription")}</p>
        </div>
      </header>
      {agents.map((row) => {
        const skills = [...row.skills].sort((a, b) =>
          a.name.localeCompare(b.name),
        );
        return (
          <details className="fdy-official-skills-agent" key={row.provider}>
            <summary>
              <ChevronRight
                aria-hidden="true"
                className="fdy-official-skills-chevron"
                size={14}
              />
              <RuntimeMark runtime={row.provider} />
              <strong>{agentNames[row.provider]}</strong>
              <span className="fdy-official-skills-count">
                {t("workspace.officialCount", { count: skills.length })}
              </span>
              <span className="fdy-official-skills-preview">
                {skills.map((skill) => skill.name).join(", ")}
              </span>
            </summary>
            <ul>
              {skills.map((skill) => (
                <li key={skill.name}>
                  <strong>
                    {skill.name}
                    {skill.source ? (
                      <span className="fdy-official-skills-source">
                        {t("workspace.officialFromFoundry", {
                          source: skill.source,
                        })}
                      </span>
                    ) : null}
                  </strong>
                  {skill.description ? <span>{skill.description}</span> : null}
                </li>
              ))}
            </ul>
          </details>
        );
      })}
    </section>
  );
}
