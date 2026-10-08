import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import type { ProviderHealth } from "@bd777/foundry-protocol";
import { RuntimeMark } from "../../components/ui/runtime-mark";

// i18n-ignore: runtime product names
const agentNames = { claude: "Claude Code", codex: "Codex" } as const;

/**
 * The skills Claude Code and Codex ship themselves, as read on the
 * workspace's device: one collapsed row per agent, since they are not chosen
 * here. A session always has its own agent's official skills.
 */
export function OfficialSkillsSection({
  providerHealth,
}: {
  providerHealth: ProviderHealth[];
}) {
  const { t } = useTranslation("skills");
  const agents = providerHealth.filter((row) => row.officialSkills?.length);
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
        const skills = [...(row.officialSkills ?? [])].sort((a, b) =>
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
                  <strong>{skill.name}</strong>
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
