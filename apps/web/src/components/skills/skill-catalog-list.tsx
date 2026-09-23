import { useState, useMemo, type ReactNode } from "react";
import { Search, X } from "lucide-react";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { TextInput } from "../../components/ui/field";
import { SelectMenu } from "../../components/ui/select-menu";
import { searchNormalizedSkills } from "./skill-search-filter";
import { SkillCatalogRow } from "./skill-catalog-row";
import type { NormalizedSkill } from "./skill-models";
import type { MissingSkillDependency } from "./skill-selection-engine";

export interface SkillCatalogListProps<
  T extends NormalizedSkill = NormalizedSkill,
> {
  mode: "workspace" | "device";
  skills: T[];
  title?: string;
  description?: string;

  // Search filter
  searchPlaceholder?: string;

  // Status Filter
  statusFilterOptions?: Array<{ value: string; label: string }>;
  statusFilterValue?: string;
  onStatusFilterChange?: (val: string) => void;
  statusFilterPredicate?: (skill: T, filterValue: string) => boolean;

  // Workspace selection props
  selectedIds?: Set<string>;
  onToggleSelect?: (skill: T) => void;
  requiredByMap?: Map<string, string[]>;
  relatedToMap?: Map<string, string[]>;
  missingRequiredMap?: Map<string, MissingSkillDependency[]>;
  activeSkillNames?: Set<string>;

  // Device action props
  renderBadges?: (skill: T) => ReactNode;
  renderActions?: (skill: T) => ReactNode;

  // Slots
  headerExtras?: ReactNode;
  footerActions?: ReactNode;
  emptyState?: {
    title: string;
    body: string;
    action?: ReactNode;
  };
}

export function SkillCatalogList<T extends NormalizedSkill = NormalizedSkill>({
  mode,
  skills,
  title,
  description,
  searchPlaceholder = "Filter by name or description",
  statusFilterOptions,
  statusFilterValue = "all",
  onStatusFilterChange,
  statusFilterPredicate,
  selectedIds,
  onToggleSelect,
  requiredByMap,
  relatedToMap,
  missingRequiredMap,
  activeSkillNames,
  renderBadges,
  renderActions,
  headerExtras,
  footerActions,
  emptyState,
}: SkillCatalogListProps<T>) {
  const [query, setQuery] = useState("");

  const filteredSkills = useMemo(() => {
    return searchNormalizedSkills(skills, query, (skill) => {
      if (statusFilterPredicate && statusFilterValue) {
        return statusFilterPredicate(skill, statusFilterValue);
      }
      return true;
    });
  }, [skills, query, statusFilterPredicate, statusFilterValue]);

  const isWorkspace = mode === "workspace";
  const hasActiveFilter = Boolean(
    query.trim() || (statusFilterValue && statusFilterValue !== "all"),
  );

  return (
    <section
      className={isWorkspace ? "fdy-workspace-skills" : "fdy-local-skills"}
    >
      {title || description ? (
        <header
          className={isWorkspace ? "fdy-workspace-skills-heading" : undefined}
        >
          {title ? <h2>{title}</h2> : null}
          {description ? <p>{description}</p> : null}
        </header>
      ) : null}

      {headerExtras}

      {skills.length > 0 ? (
        <>
          <div className="fdy-skill-filter">
            <Search size={14} aria-hidden="true" />
            <TextInput
              aria-label={searchPlaceholder}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              tone="boxed"
              type="text"
              value={query}
            />
            {query ? (
              <Button
                aria-label="Clear filter"
                onClick={() => setQuery("")}
                size="icon"
                variant="ghost"
              >
                <X size={14} />
              </Button>
            ) : null}
          </div>

          {statusFilterOptions && onStatusFilterChange ? (
            <div className="fdy-skill-server-filter">
              <SelectMenu
                ariaLabel="Filter by status"
                onChange={onStatusFilterChange}
                options={statusFilterOptions}
                tone="field"
                value={statusFilterValue}
              />
            </div>
          ) : null}

          <p className="fdy-skill-filter-count">
            {hasActiveFilter
              ? `${filteredSkills.length} of ${skills.length} match this filter.`
              : `${skills.length} skills available.`}
          </p>
        </>
      ) : null}

      {skills.length === 0 ? (
        emptyState ? (
          <div className="fdy-workspace-skills-empty">
            <EmptyState body={emptyState.body} title={emptyState.title} />
            {emptyState.action}
          </div>
        ) : (
          <EmptyState body="No skills available." title="No skills found" />
        )
      ) : filteredSkills.length === 0 ? (
        <EmptyState
          body={
            hasActiveFilter
              ? "No skills match this filter. Try adjusting your search query or status filter."
              : "No skills match."
          }
          title="No matching skills"
        />
      ) : (
        <ul className={isWorkspace ? "fdy-skill-select-list" : undefined}>
          {filteredSkills.map((skill) => (
            <SkillCatalogRow
              activeSkillNames={activeSkillNames}
              checked={selectedIds ? selectedIds.has(skill.id) : false}
              key={skill.id}
              missingDependencies={missingRequiredMap?.get(skill.id)}
              mode={mode}
              onToggle={() => onToggleSelect?.(skill)}
              query={query}
              relatedTo={relatedToMap?.get(skill.id)}
              renderActions={
                renderActions ? () => renderActions(skill) : undefined
              }
              renderBadges={
                renderBadges ? () => renderBadges(skill) : undefined
              }
              requiredBy={requiredByMap?.get(skill.id)}
              skill={skill}
            />
          ))}
        </ul>
      )}

      {footerActions}
    </section>
  );
}
