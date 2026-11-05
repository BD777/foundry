import { Alert } from "../ui/alert";
import { Trans, useTranslation } from "react-i18next";
import type { SkillDependency } from "@bd777/foundry-protocol";
import type { MissingSkillDependency } from "./skill-selection-engine";
import { SkillNote } from "./skill-note";

export interface SkillDependenciesViewProps {
  dependencies?: SkillDependency[];
  dependencyAnalysisError?: string;
  missingDependencies?: MissingSkillDependency[];
  activeSkillNames?: Set<string>;
}

export function SkillDependenciesView({
  dependencies,
  dependencyAnalysisError,
  missingDependencies,
  activeSkillNames,
}: SkillDependenciesViewProps) {
  const { t } = useTranslation("skills");
  const hasDeps = Boolean(dependencies && dependencies.length > 0);
  const hasError = Boolean(dependencyAnalysisError);
  const hasMissing = Boolean(
    missingDependencies && missingDependencies.length > 0,
  );

  if (!hasDeps && !hasError && !hasMissing) return null;

  const requiredCount =
    dependencies?.filter((d) => d.strength === "required").length ?? 0;
  const relatedCount =
    dependencies?.filter((d) => d.strength === "related").length ?? 0;

  return (
    <div>
      {hasDeps ? (
        <details className="mt-1.5 min-w-0 text-xs">
          <summary className="cursor-pointer text-ink-muted">
            {t("dependencies.summary", {
              required: requiredCount,
              related: relatedCount,
            })}
          </summary>
          <ul className="grid min-w-0 gap-2 [overflow-wrap:anywhere]">
            {dependencies!.map((dep, index) => {
              const isActive = activeSkillNames?.has(
                dep.skillName.toLowerCase(),
              );
              return (
                <li className="grid gap-1" key={index}>
                  <strong className="text-sm font-[650] text-ink">
                    {dep.skillName} ·{" "}
                    {t(`dependencies.strength.${dep.strength}`)}
                    {dep.status && dep.status !== "resolved"
                      ? ` · ${t(`dependencies.status.${dep.status}`)}`
                      : ""}
                    {isActive ? t("dependencies.activeInWorkspace") : ""}
                  </strong>
                  {dep.evidence ? (
                    <SkillNote className="text-2xs">{dep.evidence}</SkillNote>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}

      {hasMissing ? (
        <Alert
          className="mt-2"
          size="compact"
          title={t("dependencies.missingTitle", {
            count: missingDependencies!.length,
          })}
          tone="error"
        >
          <ul className="m-0 grid list-none gap-0.5 p-0">
            {missingDependencies!.map((missing, index) => (
              <li key={index}>
                <Trans
                  components={{ b: <strong /> }}
                  i18nKey="dependencies.missing"
                  ns="skills"
                  values={{ name: missing.missingSkillName }}
                />
                {missing.evidence ? ` (${missing.evidence})` : ""}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {hasError ? (
        <Alert
          tone="error"
          size="compact"
          title={t("dependencies.analysisIncomplete", {
            error: dependencyAnalysisError,
          })}
        />
      ) : null}
    </div>
  );
}
