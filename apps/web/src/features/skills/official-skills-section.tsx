import { useTranslation } from "react-i18next";
import { ArrowRight, ChevronRight } from "lucide-react";
import type { BuiltinSkill, ProviderHealth } from "@bd777/foundry-protocol";
import { navigateToFoundrySkill } from "../../lib/in-app-navigation";
import { Button } from "../../components/ui/button";
import { RowCard } from "../../components/ui/row-card";
import { SkillCatalogHeading } from "../../components/skills/skill-catalog-heading";
import {
  RuntimeMark,
  runtimeMeta,
} from "../../components/agent-runtime/runtime-mark";

/**
 * The skills each agent always has: the ones Claude Code and Codex ship, as
 * read on the workspace's device, and the ones Foundry adds for that agent.
 * One collapsed row per agent, since they are not chosen here. Foundry's
 * own foundry skill opens a page on what it gives agents.
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
    <section className="mb-7 grid min-w-0 gap-2">
      <SkillCatalogHeading
        description={t("workspace.officialDescription")}
        title={t("workspace.officialTitle")}
      />
      {agents.map((row) => {
        const skills = [...row.skills].sort((a, b) =>
          a.name.localeCompare(b.name),
        );
        return (
          <RowCard
            as="details"
            className="group"
            key={row.provider}
            tone="ring"
          >
            <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2.5 transition-colors duration-140 hover:bg-surface focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-brand [&::-webkit-details-marker]:hidden">
              <ChevronRight
                aria-hidden="true"
                className="shrink-0 text-ink-faint transition-transform duration-140 group-open:rotate-90"
                size={14}
              />
              <RuntimeMark runtime={row.provider} />
              <strong className="shrink-0 text-sm text-ink">
                {runtimeMeta(row.provider).productName}
              </strong>
              <span className="shrink-0 text-xs text-ink-muted">
                {t("workspace.officialCount", { count: skills.length })}
              </span>
              <span className="min-w-0 truncate text-xs text-ink-faint max-[700px]:hidden">
                {skills.map((skill) => skill.name).join(", ")}
              </span>
            </summary>
            <ul className="grid gap-0.5 pt-1 pr-3 pb-3 pl-8.5">
              {skills.map((skill) => (
                <li className="grid min-w-0 gap-0.5 py-1.5" key={skill.name}>
                  <strong className="text-xs text-ink">
                    {skill.name}
                    {skill.source ? (
                      <span className="ml-2 text-xs font-normal text-ink-muted">
                        {t("workspace.officialFromFoundry", {
                          source: skill.source,
                        })}
                      </span>
                    ) : null}
                  </strong>
                  {skill.description ? (
                    <span className="truncate text-xs text-ink-muted">
                      {skill.description}
                    </span>
                  ) : null}
                  {skill.source && skill.name === "foundry" ? (
                    <Button
                      aria-label={t("foundrySkill.openLabel", {
                        name: skill.name,
                      })}
                      className="fdy-official-skills-open mt-0.5 justify-self-start text-xs"
                      size="inline"
                      variant="link"
                      onClick={navigateToFoundrySkill}
                    >
                      {t("foundrySkill.open")}
                      <ArrowRight aria-hidden="true" size={13} />
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </RowCard>
        );
      })}
    </section>
  );
}
