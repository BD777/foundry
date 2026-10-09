import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Checkbox } from "../../components/ui/field";
import { Badge } from "../../components/ui/badge";
import { SkillSearchHighlight } from "./skill-search-filter";
import {
  SkillDependenciesView,
  type SkillDependenciesViewProps,
} from "./skill-dependencies-view";
import type { NormalizedSkill } from "./skill-models";

export interface SkillCatalogRowProps {
  skill: NormalizedSkill;
  query: string;
  mode: "workspace" | "device";

  // Workspace mode props
  checked?: boolean;
  disabled?: boolean;
  onToggle?: () => void;
  requiredBy?: string[];
  relatedTo?: string[];
  activeSkillNames?: Set<string>;
  missingDependencies?: SkillDependenciesViewProps["missingDependencies"];

  // Device mode props
  renderBadges?: (skill: NormalizedSkill) => ReactNode;
  renderActions?: (skill: NormalizedSkill) => ReactNode;
}

export function SkillCatalogRow({
  skill,
  query,
  mode,
  checked = false,
  disabled = false,
  onToggle,
  requiredBy,
  relatedTo,
  activeSkillNames,
  missingDependencies,
  renderBadges,
  renderActions,
}: SkillCatalogRowProps) {
  const { t } = useTranslation("skills");
  const isWorkspace = mode === "workspace";

  const handleRowClick = (e: React.MouseEvent) => {
    if (!isWorkspace || disabled || !onToggle) return;
    const target = e.target as HTMLElement;
    if (
      target.closest("details") ||
      target.closest("button") ||
      target.closest("a") ||
      target.closest("input")
    ) {
      return;
    }
    onToggle();
  };

  const hasActions = Boolean(renderBadges || renderActions);
  const isRequired = Boolean(requiredBy && requiredBy.length > 0);
  const isRelated = Boolean(relatedTo && relatedTo.length > 0 && !isRequired);

  return (
    <li
      className={
        isWorkspace
          ? `fdy-skill-select-row${checked ? " is-selected" : ""}${hasActions ? " has-actions" : ""}`
          : "fdy-local-skill-row"
      }
      onClick={handleRowClick}
    >
      {isWorkspace ? (
        <Checkbox
          aria-label={t("row.select", { name: skill.name })}
          checked={checked}
          className="fdy-skill-select-check"
          disabled={disabled}
          onChange={() => onToggle?.()}
        />
      ) : null}

      <div
        className={
          isWorkspace ? "fdy-skill-select-copy" : "fdy-local-skill-copy"
        }
      >
        <div className="fdy-skill-row-title-bar">
          <strong>
            <SkillSearchHighlight query={query} text={skill.name} />
          </strong>
          {isRequired ? (
            <Badge
              tone="neutral"
              title={t("row.requiredByTitle", {
                names: requiredBy!.join(", "),
              })}
            >
              {t("row.requiredBy", { name: requiredBy![0] })}
              {requiredBy!.length > 1
                ? t("row.more", { count: requiredBy!.length - 1 })
                : ""}
            </Badge>
          ) : isRelated ? (
            <Badge
              tone="neutral"
              title={t("row.relatedToTitle", {
                names: relatedTo!.join(", "),
              })}
            >
              {t("row.relatedTo", { name: relatedTo![0] })}
              {relatedTo!.length > 1
                ? t("row.more", { count: relatedTo!.length - 1 })
                : ""}
            </Badge>
          ) : null}
        </div>

        {skill.description ? (
          <span className={isWorkspace ? "fdy-skill-select-desc" : undefined}>
            <SkillSearchHighlight query={query} text={skill.description} />
          </span>
        ) : null}

        <small>
          <SkillSearchHighlight query={query} text={skill.subtitle} />
        </small>
        {skill.requires?.length ? (
          <small>
            {t("row.requires", { tools: skill.requires.join(", ") })}
          </small>
        ) : null}

        <SkillDependenciesView
          activeSkillNames={activeSkillNames}
          dependencies={skill.dependencies}
          dependencyAnalysisError={skill.dependencyAnalysisError}
          missingDependencies={missingDependencies}
        />
      </div>

      {hasActions ? (
        <div className="fdy-skill-row-actions">
          {renderBadges?.(skill)}
          {renderActions?.(skill)}
        </div>
      ) : null}
    </li>
  );
}
