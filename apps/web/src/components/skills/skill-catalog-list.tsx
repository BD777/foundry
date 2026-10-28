import { useState, useMemo, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SkillBundleSummary } from "@bd777/foundry-protocol";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { TextInput } from "../../components/ui/field";
import { SelectMenu } from "../../components/ui/select-menu";
import { searchNormalizedSkills } from "./skill-search-filter";
import { SkillCatalogRow } from "./skill-catalog-row";
import type { NormalizedSkill } from "./skill-models";
import type { MissingSkillDependency } from "./skill-selection-engine";
import { Skeleton } from "../ui/loading";

export interface SkillCatalogListProps<
  T extends NormalizedSkill = NormalizedSkill,
> {
  mode: "workspace" | "device";
  skills: T[];
  bundles?: SkillBundleSummary[];
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
  /** Shows the selection but does not let it change. */
  selectionDisabled?: boolean;
  requiredByMap?: Map<string, string[]>;
  relatedToMap?: Map<string, string[]>;
  missingRequiredMap?: Map<string, MissingSkillDependency[]>;
  activeSkillNames?: Set<string>;

  // Device action props
  renderBadges?: (skill: T) => ReactNode;
  renderActions?: (skill: T) => ReactNode;

  // Slots
  /** Actions in the heading row, right-aligned, visible above the list. */
  headerActions?: ReactNode;
  headerExtras?: ReactNode;
  footerActions?: ReactNode;
  emptyState?: {
    title: string;
    body: string;
    action?: ReactNode;
  };
  /** The skills are still being read: say so instead of the empty state. */
  loading?: boolean;
}

export function SkillCatalogList<T extends NormalizedSkill = NormalizedSkill>({
  mode,
  skills,
  bundles,
  title,
  description,
  searchPlaceholder,
  statusFilterOptions,
  statusFilterValue = "all",
  onStatusFilterChange,
  statusFilterPredicate,
  selectedIds,
  onToggleSelect,
  selectionDisabled,
  requiredByMap,
  relatedToMap,
  missingRequiredMap,
  activeSkillNames,
  renderBadges,
  renderActions,
  headerActions,
  headerExtras,
  footerActions,
  emptyState,
  loading,
}: SkillCatalogListProps<T>) {
  const { t } = useTranslation(["skills", "common"]);
  const placeholder = searchPlaceholder ?? t("catalog.searchPlaceholder");
  const [query, setQuery] = useState("");
  const [expandedBundles, setExpandedBundles] = useState<Set<string>>(
    () => new Set(),
  );

  const filteredSkills = useMemo(() => {
    return searchNormalizedSkills(skills, query, (skill) => {
      if (statusFilterPredicate && statusFilterValue) {
        return statusFilterPredicate(skill, statusFilterValue);
      }
      return true;
    });
  }, [skills, query, statusFilterPredicate, statusFilterValue]);

  const isSearching = Boolean(query.trim());

  const toggleBundle = (bundleId: string) => {
    setExpandedBundles((prev) => {
      const next = new Set(prev);
      if (next.has(bundleId)) next.delete(bundleId);
      else next.add(bundleId);
      return next;
    });
  };

  type CatalogItem =
    | { kind: "skill"; skill: T }
    | { kind: "bundle"; bundle: SkillBundleSummary; skills: T[] };

  const catalogItems = useMemo<CatalogItem[]>(() => {
    if (!bundles || bundles.length === 0) {
      return filteredSkills.map((skill) => ({ kind: "skill", skill }));
    }

    const multiBundles = new Map<string, SkillBundleSummary>();
    const skillToBundleMap = new Map<string, SkillBundleSummary>();
    for (const b of bundles) {
      if (b.skillIds && b.skillIds.length > 1) {
        multiBundles.set(b.id, b);
        for (const sid of b.skillIds) {
          skillToBundleMap.set(sid, b);
        }
      }
    }

    const items: CatalogItem[] = [];
    const seenBundles = new Set<string>();

    for (const skill of filteredSkills) {
      const b = skillToBundleMap.get(skill.id);
      if (!b) {
        items.push({ kind: "skill", skill });
      } else {
        if (!seenBundles.has(b.id)) {
          seenBundles.add(b.id);
          const bundleSkills = filteredSkills.filter((s) =>
            b.skillIds.includes(s.id),
          );
          if (bundleSkills.length > 0) {
            items.push({ kind: "bundle", bundle: b, skills: bundleSkills });
          }
        }
      }
    }
    return items;
  }, [filteredSkills, bundles]);

  const isWorkspace = mode === "workspace";
  const hasActiveFilter = Boolean(
    query.trim() || (statusFilterValue && statusFilterValue !== "all"),
  );

  const renderSkillRow = (skill: T) => (
    <SkillCatalogRow
      activeSkillNames={activeSkillNames}
      checked={selectedIds ? selectedIds.has(skill.id) : false}
      disabled={selectionDisabled}
      key={skill.id}
      missingDependencies={missingRequiredMap?.get(skill.id)}
      mode={mode}
      onToggle={() => onToggleSelect?.(skill)}
      query={query}
      relatedTo={relatedToMap?.get(skill.id)}
      renderActions={renderActions ? () => renderActions(skill) : undefined}
      renderBadges={renderBadges ? () => renderBadges(skill) : undefined}
      requiredBy={requiredByMap?.get(skill.id)}
      skill={skill}
    />
  );

  return (
    <section
      className={isWorkspace ? "fdy-workspace-skills" : "fdy-local-skills"}
    >
      {title || description || headerActions ? (
        <header
          className={
            isWorkspace
              ? "fdy-skill-catalog-heading fdy-workspace-skills-heading"
              : "fdy-skill-catalog-heading"
          }
        >
          <div className="fdy-skill-catalog-heading-copy">
            {title ? <h2>{title}</h2> : null}
            {description ? <p>{description}</p> : null}
          </div>
          {headerActions ? (
            <div className="fdy-skill-catalog-heading-actions">
              {headerActions}
            </div>
          ) : null}
        </header>
      ) : null}

      {headerExtras}

      {skills.length > 0 ? (
        <>
          <div className="fdy-skill-filter">
            <Search size={14} aria-hidden="true" />
            <TextInput
              aria-label={placeholder}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={placeholder}
              tone="boxed"
              type="text"
              value={query}
            />
            {query ? (
              <Button
                aria-label={t("catalog.clearFilter")}
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
                ariaLabel={t("catalog.filterByStatus")}
                onChange={onStatusFilterChange}
                options={statusFilterOptions}
                tone="field"
                value={statusFilterValue}
              />
            </div>
          ) : null}

          <p className="fdy-skill-filter-count">
            {hasActiveFilter
              ? t("catalog.matchCount", {
                  matched: filteredSkills.length,
                  total: skills.length,
                })
              : t("catalog.available", { count: skills.length })}
          </p>
        </>
      ) : null}

      {skills.length === 0 && loading ? (
        <Skeleton label={t("common:states.loading")} rows={4} variant="rows" />
      ) : skills.length === 0 ? (
        emptyState ? (
          <div className="fdy-workspace-skills-empty">
            <EmptyState body={emptyState.body} title={emptyState.title} />
            {emptyState.action ? (
              <div className="fdy-workspace-skills-empty-action">
                {emptyState.action}
              </div>
            ) : null}
          </div>
        ) : (
          <EmptyState
            body={t("catalog.emptyBody")}
            title={t("catalog.emptyTitle")}
          />
        )
      ) : filteredSkills.length === 0 ? (
        <EmptyState
          body={
            hasActiveFilter
              ? t("catalog.noMatchFiltered")
              : t("catalog.noMatch")
          }
          title={t("catalog.noMatchTitle")}
        />
      ) : (
        <ul className={isWorkspace ? "fdy-skill-select-list" : undefined}>
          {catalogItems.map((item) => {
            if (item.kind === "skill") {
              return renderSkillRow(item.skill);
            }

            const bundle = item.bundle;
            const expanded = isSearching || expandedBundles.has(bundle.id);
            const totalSkills = bundle.skillIds.length;
            const selectedCount = selectedIds
              ? item.skills.filter((s) => selectedIds.has(s.id)).length
              : 0;

            return (
              <li key={bundle.id} className="fdy-skill-bundle-group">
                <div
                  className={`fdy-skill-bundle-header${expanded ? " is-expanded" : ""}`}
                  onClick={() => toggleBundle(bundle.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggleBundle(bundle.id);
                    }
                  }}
                  aria-expanded={expanded}
                  aria-label={`${bundle.name} (${t("workspace.bundleSkillsCount", { count: totalSkills })})`}
                >
                  <span className="fdy-skill-bundle-chevron" aria-hidden="true">
                    {expanded ? (
                      <ChevronDown size={14} />
                    ) : (
                      <ChevronRight size={14} />
                    )}
                  </span>
                  <div className="fdy-skill-bundle-header-copy">
                    <strong className="fdy-skill-bundle-title">
                      {bundle.name}
                    </strong>
                    <Badge tone="neutral">{t("library.bundle.badge")}</Badge>
                    <span className="fdy-skill-bundle-meta">
                      {t("workspace.bundleSkillsCount", { count: totalSkills })}
                      {mode === "workspace" && (
                        <>
                          {" · "}
                          {selectedCount === totalSkills
                            ? t("workspace.bundleAllSelected", {
                                count: totalSkills,
                              })
                            : t("workspace.bundleSelectedCount", {
                                selected: selectedCount,
                                total: totalSkills,
                              })}
                        </>
                      )}
                      {isSearching && item.skills.length !== totalSkills && (
                        <>
                          {" · "}
                          {t("workspace.bundleMatches", {
                            count: item.skills.length,
                          })}
                        </>
                      )}
                    </span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="fdy-skill-bundle-toggle-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleBundle(bundle.id);
                    }}
                  >
                    {expanded
                      ? t("workspace.collapseBundle")
                      : t("workspace.expandBundle")}
                  </Button>
                </div>

                {expanded ? (
                  <ul className="fdy-skill-bundle-sublist">
                    {item.skills.map(renderSkillRow)}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {footerActions}
    </section>
  );
}
