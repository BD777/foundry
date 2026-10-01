import { AlertTriangle } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import type { SkillDependency } from "@bd777/foundry-protocol";
import type { MissingSkillDependency } from "./skill-selection-engine";

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
    <div className="fdy-skill-dependencies-wrapper">
      {hasDeps ? (
        <details className="fdy-skill-dependencies">
          <summary>
            {t("dependencies.summary", {
              required: requiredCount,
              related: relatedCount,
            })}
          </summary>
          <ul className="fdy-skill-dependency-list">
            {dependencies!.map((dep, index) => {
              const isActive = activeSkillNames?.has(
                dep.skillName.toLowerCase(),
              );
              return (
                <li key={index}>
                  <strong>
                    {dep.skillName} ·{" "}
                    {t(`dependencies.strength.${dep.strength}`)}
                    {dep.status && dep.status !== "resolved"
                      ? ` · ${t(`dependencies.status.${dep.status}`)}`
                      : ""}
                    {isActive ? t("dependencies.activeInWorkspace") : ""}
                  </strong>
                  {dep.evidence ? <small>{dep.evidence}</small> : null}
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}

      {hasMissing ? (
        <ul className="fdy-skill-missing-deps">
          {missingDependencies!.map((missing, index) => (
            <li className="fdy-skill-error" role="alert" key={index}>
              <AlertTriangle size={13} />
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
      ) : null}

      {hasError ? (
        <p className="fdy-skill-error" role="alert">
          <AlertTriangle size={13} />{" "}
          {t("dependencies.analysisIncomplete", {
            error: dependencyAnalysisError,
          })}
        </p>
      ) : null}
    </div>
  );
}
