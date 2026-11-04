import { useState, useMemo, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SkillBundleSummary } from "@bd777/foundry-protocol";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { TextInput } from "../../components/ui/field";
import { RowCard } from "../../components/ui/row-card";
import { SelectMenu } from "../../components/ui/select-menu";
import { cn } from "../../lib/cn";
import { BundleTitle } from "./skill-bundle-title";
import { SkillCatalogHeading } from "./skill-catalog-heading";
import { searchNormalizedSkills } from "./skill-search-filter";
import { SkillCatalogRow } from "./skill-catalog-row";
import type { NormalizedSkill } from "./skill-models";
import type { MissingSkillDependency } from "./skill-selection-engine";
import { Skeleton } from "../ui/loading";

export interface SkillCatalogListProps<
  T extends NormalizedSkill = NormalizedSkill,
> {
  mode: "workspace" | "device";
  className?: string;
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
  className,
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
    <section className={className}>
      {title || description || headerActions ? (
        <SkillCatalogHeading
          actions={headerActions}
          className={isWorkspace ? "mb-4 max-w-full" : undefined}
          description={description}
          title={title}
        />
      ) : null}

      {headerExtras}

      {skills.length > 0 ? (
        <>
          <div className="relative mb-3 flex items-center gap-1.5">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-2.75 flex-none text-ink-faint"
              size={14}
            />
            <TextInput
              aria-label={placeholder}
              className="pl-8"
              onChange={(e) => setQuery(e.target.value)}
              placeholder={placeholder}
              tone="boxed"
              type="text"
              value={query}
            />
            {query ? (
              <Button
                aria-label={t("catalog.clearFilter")}
                className="flex-none"
                onClick={() => setQuery("")}
                size="icon"
                variant="ghost"
              >
                <X size={14} />
              </Button>
            ) : null}
          </div>

          {statusFilterOptions && onStatusFilterChange ? (
            <div className="mb-3 flex cursor-pointer items-center gap-2 text-xs text-ink-muted">
              <SelectMenu
                ariaLabel={t("catalog.filterByStatus")}
                onChange={onStatusFilterChange}
                options={statusFilterOptions}
                tone="field"
                value={statusFilterValue}
              />
            </div>
          ) : null}

          <p className="mb-3 text-2xs text-ink-faint">
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
          <div className="flex flex-col items-stretch gap-3">
            <EmptyState body={emptyState.body} title={emptyState.title} />
            {emptyState.action ? (
              <div className="self-start">{emptyState.action}</div>
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
        <ul
          className={cn(
            "grid min-w-0 gap-1.5",
            !isWorkspace && "mb-2.5 flex w-full flex-col",
          )}
        >
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
              <li key={bundle.id} className="grid gap-1.5">
                <RowCard
                  aria-expanded={expanded}
                  aria-label={`${bundle.name} (${t("workspace.bundleSkillsCount", { count: totalSkills })})`}
                  className="fdy-skill-bundle-header flex select-none items-center gap-2.5 px-3.25 py-2.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                  interactive
                  onClick={() => toggleBundle(bundle.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggleBundle(bundle.id);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <span
                    aria-hidden="true"
                    className="flex flex-none items-center justify-center text-ink-muted"
                  >
                    {expanded ? (
                      <ChevronDown size={14} />
                    ) : (
                      <ChevronRight size={14} />
                    )}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                    <BundleTitle as="strong">{bundle.name}</BundleTitle>
                    <Badge tone="neutral">{t("library.bundle.badge")}</Badge>
                    <span className="text-xs font-medium text-ink-faint">
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
                    className="flex-none px-2"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleBundle(bundle.id);
                    }}
                  >
                    {expanded
                      ? t("workspace.collapseBundle")
                      : t("workspace.expandBundle")}
                  </Button>
                </RowCard>

                {expanded ? (
                  <ul className="fdy-skill-bundle-sublist ml-3.5 grid gap-1.5 border-l-2 border-line pl-4">
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
