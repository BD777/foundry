import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, AlertTriangle, CheckCircle2 } from "lucide-react";
import type {
  DeviceProjection,
  BuiltinSkill,
  DeviceTool,
  PromotedSkill,
  SkillBundleSummary,
  ProviderHealth,
  WorkspaceProjection,
  WorkspaceSkillBinding,
} from "@bd777/foundry-protocol";
import { Button } from "../../components/ui/button";
import { PageSurface } from "../../components/ui/page-surface";
import { SkillCatalogList } from "../../components/skills/skill-catalog-list";
import { useDeviceSkills } from "../../components/skills/use-device-skills";
import { LocalSkillsSection, localOnlySkills } from "./local-skills-section";
import {
  BuiltinShadowBadge,
  ReplacesOfficialBadge,
} from "./builtin-shadow-badge";
import { DefaultSkillBadge, ViaBundleBadge } from "./default-skill-badge";
import { WorkspaceBundles } from "./workspace-bundles";
import { MissingToolsBadge } from "./missing-tools-badge";
import { OfficialSkillsSection } from "./official-skills-section";
import { SkillVersionPin } from "./skill-version-pin";
import { useWorkspaceSkillSelection } from "./use-workspace-skill-selection";

export type SkillsFeatureEvent =
  | { type: "manage-devices.requested" }
  | { message: string; type: "notice.requested" };

export interface SkillsFeatureProps {
  embedded?: boolean;
  catalog: PromotedSkill[];
  bindings: WorkspaceSkillBinding[];
  devices: DeviceProjection[];
  /** The workspace device's Claude Code / Codex, with their own skills. */
  providerHealth?: ProviderHealth[];
  /** Skills Foundry itself gives each agent. */
  builtinSkills?: BuiltinSkill[];
  /** Which programs skills need the devices have. */
  deviceTools?: DeviceTool[];
  /** Owner's default skills this workspace gets besides its selection. */
  defaultSkillIds?: string[];
  /** The library's bundles, and the ones this workspace uses. */
  skillBundles?: SkillBundleSummary[];
  workspaceBundleIds?: string[];
  /** Its owner's default bundles; workspaceBundleIds holds those still on. */
  defaultBundleIds?: string[];
  /** Skills it gets from defaults or bundles, and those it turned off. */
  inheritedSkillIds?: string[];
  offSkillIds?: string[];
  /** Workspaces, to tell a workspace's own skill drafts apart. */
  workspaces?: WorkspaceProjection[];
  workspaceId: string;
  /** The device this workspace runs on; its local skills can be added here. */
  workspaceDeviceId?: string;
  /** Why the caller cannot change this workspace's skill selection. */
  readOnlyReason?: string;
  onEvent?: (event: SkillsFeatureEvent) => void;
  onChanged?: () => Promise<void>;
}

/**
 * Workspace skill selection. The catalog is server-owned (entries arrive via
 * device promotion); this view chooses which entries the workspace exposes
 * to its Chats and Issues runs, automatically activating required and related
 * dependencies by default.
 */
export function SkillsFeature({
  onEvent,
  catalog,
  bindings,
  devices,
  providerHealth,
  builtinSkills,
  defaultSkillIds,
  deviceTools,
  skillBundles,
  workspaceBundleIds,
  defaultBundleIds,
  inheritedSkillIds,
  offSkillIds,
  workspaces,
  workspaceId,
  workspaceDeviceId,
  readOnlyReason,
  embedded,
  onChanged,
}: SkillsFeatureProps) {
  const { t } = useTranslation(["skills", "common"]);
  const statusFilterOptions = [
    { value: "all", label: t("workspace.filterAll") },
    { value: "selected", label: t("workspace.filterSelected") },
    { value: "unselected", label: t("workspace.filterUnselected") },
  ];
  const [statusFilter, setStatusFilter] = useState("all");
  const workspaceDevice = devices.find((d) => d.id === workspaceDeviceId);
  const { skills: deviceSkills, reload: reloadDeviceSkills } =
    useDeviceSkills(workspaceDevice);
  const viaBundle = new Map(
    (skillBundles ?? [])
      .filter((bundle) => workspaceBundleIds?.includes(bundle.id))
      .flatMap((bundle) => bundle.skillIds.map((id) => [id, bundle.name])),
  );
  const {
    normalizedSkills,
    resolution,
    onIds,
    activeSkillNames,
    dirty,
    duplicateNames,
    saving,
    error,
    notice,
    setNotice,
    save,
    handleToggle,
    selectAfterPublish,
  } = useWorkspaceSkillSelection({
    catalog,
    bindings,
    devices,
    deviceSkills,
    inheritedSkillIds,
    offSkillIds,
    workspaceId,
    readOnlyReason,
    onChanged,
    t,
  });

  return (
    <PageSurface embedded={embedded} variant="skills">
      {error ? (
        <p className="fdy-skill-error" role="alert">
          <AlertTriangle size={13} /> {error}
        </p>
      ) : null}

      {notice ? (
        <p className="fdy-skill-notice" role="status">
          <CheckCircle2 size={14} />
          <span>{notice}</span>
          <Button
            aria-label={t("workspace.dismissNotice")}
            onClick={() => setNotice(undefined)}
            size="sm"
            variant="ghost"
          >
            {t("workspace.dismiss")}
          </Button>
        </p>
      ) : null}

      <OfficialSkillsSection
        builtinSkills={builtinSkills ?? []}
        providerHealth={providerHealth ?? []}
      />

      <WorkspaceBundles
        bundles={skillBundles ?? []}
        onChanged={onChanged}
        readOnly={!!readOnlyReason}
        defaultIds={defaultBundleIds ?? []}
        selectedIds={workspaceBundleIds ?? []}
        workspaceId={workspaceId}
      />

      <SkillCatalogList
        activeSkillNames={activeSkillNames}
        description={
          defaultSkillIds?.some((id) =>
            normalizedSkills.some((skill) => skill.id === id),
          )
            ? t("workspace.defaultSkillsHint")
            : undefined
        }
        emptyState={{
          title: t("workspace.emptyTitle"),
          body: t("workspace.emptyBody"),
          // With skills to add from this workspace's device right below,
          // sending people to Devices would be a detour.
          action:
            workspaceDeviceId &&
            localOnlySkills(
              deviceSkills,
              workspaceDeviceId,
              workspaces,
              workspaceId,
            ).length ? undefined : (
              <Button
                onClick={() => onEvent?.({ type: "manage-devices.requested" })}
              >
                {t("workspace.goToDevices")}
                <ArrowRight size={14} />
              </Button>
            ),
        }}
        headerActions={
          catalog.length > 0 ? (
            <>
              <span className="fdy-workspace-skills-count">
                {t("workspace.selectedCount", {
                  count: onIds.size,
                })}
              </span>
              <Button
                disabled={
                  !dirty ||
                  saving ||
                  !!duplicateNames.length ||
                  !!readOnlyReason
                }
                onClick={save}
              >
                {saving
                  ? t("common:actions.saving")
                  : t("workspace.saveSelection")}
              </Button>
            </>
          ) : null
        }
        headerExtras={
          catalog.length > 0 && (duplicateNames.length || readOnlyReason) ? (
            <>
              {duplicateNames.length ? (
                <p className="fdy-skill-error" role="alert">
                  {t("workspace.duplicateNames", {
                    names: duplicateNames.join(", "),
                  })}
                </p>
              ) : null}
              {readOnlyReason ? <p role="note">{readOnlyReason}</p> : null}
            </>
          ) : null
        }
        renderBadges={(skill) => (
          <>
            <DefaultSkillBadge
              off={!onIds.has(skill.id)}
              show={Boolean(defaultSkillIds?.includes(skill.id))}
            />
            <BuiltinShadowBadge
              builtinSkills={builtinSkills}
              name={skill.name}
            />
            <ReplacesOfficialBadge
              name={skill.name}
              providerHealth={providerHealth}
            />
            <ViaBundleBadge name={viaBundle.get(skill.id)} />
            <MissingToolsBadge
              deviceLabel={workspaceDevice?.label}
              deviceTools={deviceTools?.filter(
                (row) => row.deviceId === workspaceDeviceId,
              )}
              requires={skill.requires}
            />
          </>
        )}
        renderActions={(skill) =>
          skill.promotedSkill && resolution.selectedIds.has(skill.id) ? (
            <SkillVersionPin
              binding={bindings.find((row) => row.skillId === skill.id)}
              onChanged={onChanged}
              readOnly={!!readOnlyReason}
              skill={skill.promotedSkill}
              workspaceId={workspaceId}
            />
          ) : null
        }
        missingRequiredMap={resolution.missingRequired}
        mode="workspace"
        onStatusFilterChange={setStatusFilter}
        onToggleSelect={handleToggle}
        relatedToMap={resolution.relatedTo}
        requiredByMap={resolution.requiredBy}
        searchPlaceholder={t("workspace.searchPlaceholder")}
        selectedIds={onIds}
        skills={normalizedSkills}
        statusFilterOptions={statusFilterOptions}
        statusFilterPredicate={(skill, filterVal) => {
          if (filterVal === "selected") return onIds.has(skill.id);
          if (filterVal === "unselected") return !onIds.has(skill.id);
          return true;
        }}
        statusFilterValue={statusFilter}
        title={t("workspace.title")}
      />

      {workspaceDevice ? (
        <LocalSkillsSection
          device={workspaceDevice}
          deviceSkills={deviceSkills}
          workspaceId={workspaceId}
          workspaces={workspaces ?? []}
          readOnly={!!readOnlyReason}
          onChanged={async () => {
            await onChanged?.();
            await reloadDeviceSkills();
          }}
          onPromoted={(id) => selectAfterPublish(id)}
        />
      ) : null}
    </PageSurface>
  );
}
