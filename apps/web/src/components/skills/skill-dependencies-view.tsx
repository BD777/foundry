import { AlertTriangle } from "lucide-react";
import type { SkillDependency } from "@foundry/protocol";
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
            {requiredCount} required · {relatedCount} possible references
          </summary>
          <ul className="fdy-skill-dependency-list">
            {dependencies!.map((dep, index) => {
              const isActive = activeSkillNames?.has(
                dep.skillName.toLowerCase(),
              );
              return (
                <li key={index}>
                  <strong>
                    {dep.skillName} · {dep.strength}
                    {dep.status && dep.status !== "resolved"
                      ? ` · ${dep.status}`
                      : ""}
                    {isActive ? " · active in workspace" : ""}
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
              Missing required dependency:{" "}
              <strong>{missing.missingSkillName}</strong>
              {missing.evidence ? ` (${missing.evidence})` : ""}
            </li>
          ))}
        </ul>
      ) : null}

      {hasError ? (
        <p className="fdy-skill-error" role="alert">
          <AlertTriangle size={13} /> Dependency analysis incomplete:{" "}
          {dependencyAnalysisError}
        </p>
      ) : null}
    </div>
  );
}
