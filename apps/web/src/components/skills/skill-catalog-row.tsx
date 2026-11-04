import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Checkbox } from "../../components/ui/field";
import { Badge } from "../../components/ui/badge";
import { RowCard } from "../../components/ui/row-card";
import { cn } from "../../lib/cn";
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
    <RowCard
      as="li"
      className={
        isWorkspace
          ? cn(
              "grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2.5 px-3.25 py-2.75",
              hasActions &&
                "grid-cols-[auto_minmax(0,1fr)_auto] max-[640px]:grid-cols-[auto_minmax(0,1fr)]",
            )
          : "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 rounded-md px-3 py-2.5 max-[600px]:grid-cols-1"
      }
      interactive={isWorkspace}
      onClick={handleRowClick}
      selected={isWorkspace && checked}
    >
      {isWorkspace ? (
        <Checkbox
          aria-label={t("row.select", { name: skill.name })}
          checked={checked}
          className="mt-0.5 flex-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          disabled={disabled}
          onChange={() => onToggle?.()}
        />
      ) : null}

      <div className="grid min-w-0 gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <strong
            className={cn(
              "text-sm font-[650] text-ink",
              isWorkspace && "truncate",
            )}
          >
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
          <span
            className={
              isWorkspace
                ? "line-clamp-2 text-xs leading-[1.45] text-ellipsis text-ink-muted"
                : "truncate text-xs text-ink-muted"
            }
          >
            <SkillSearchHighlight query={query} text={skill.description} />
          </span>
        ) : null}

        <small className="truncate text-2xs text-ink-faint">
          <SkillSearchHighlight query={query} text={skill.subtitle} />
        </small>
        {skill.requires?.length ? (
          <small className="truncate text-2xs text-ink-faint">
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
        <div
          className={cn(
            "flex flex-wrap items-center gap-2",
            isWorkspace &&
              "justify-end empty:hidden max-[640px]:col-start-2 max-[640px]:justify-start",
          )}
        >
          {renderBadges?.(skill)}
          {renderActions?.(skill)}
        </div>
      ) : null}
    </RowCard>
  );
}
