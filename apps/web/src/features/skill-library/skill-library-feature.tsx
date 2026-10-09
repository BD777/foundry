import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import type {
  DeviceProjection,
  DeviceTool,
  PromotedSkill,
  SkillRepository,
} from "@bd777/foundry-protocol";
import {
  listMyDefaultSkills,
  listSkillRepositories,
  setMyDefaultSkills,
} from "../../api";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { PageSurface } from "../../components/ui/page-surface";
import { SkillCatalogList } from "../../components/skills/skill-catalog-list";
import {
  toNormalizedPromotedSkill,
  type NormalizedSkill,
} from "../../components/skills/skill-models";
import { AddRepositoryDialog } from "./add-repository-dialog";
import { SkillRepositoriesSection } from "./skill-repositories-section";

export interface SkillLibraryFeatureProps {
  catalog: PromotedSkill[];
  devices: DeviceProjection[];
  /** What the devices reported about programs skills and bundles need. */
  deviceTools?: DeviceTool[];
  /** Admins follow repositories, roll them back and resume them. */
  canManage: boolean;
  /** Reloads the catalog after the library changed. */
  onChanged: () => Promise<void>;
}

const sameSet = (a: Set<string>, b: Set<string>) =>
  a.size === b.size && [...a].every((id) => b.has(id));

/**
 * The server's skill library: every published skill, where it came from and
 * which of your workspaces use it. Checked skills are your defaults; every
 * workspace on your devices gets them unless it selected a same-named skill.
 */
export function SkillLibraryFeature({
  catalog,
  devices,
  deviceTools,
  canManage,
  onChanged,
}: SkillLibraryFeatureProps) {
  const { t } = useTranslation(["skills", "common"]);
  const [saved, setSaved] = useState<Set<string>>();
  const [defaultBundles, setDefaultBundles] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState("all");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // Undefined until the first answer, so the page never claims "none" early.
  const [repositories, setRepositories] = useState<SkillRepository[]>();
  const [adding, setAdding] = useState<{ repository?: SkillRepository }>();

  const loadRepositories = async () => {
    try {
      setRepositories(await listSkillRepositories());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const refresh = async () => {
    await Promise.all([loadRepositories(), onChanged()]);
  };
  useEffect(() => {
    void loadRepositories();
  }, []);
  // Picked skills whose folder left their repository, by skill id.
  const missing = useMemo(
    () =>
      new Map(
        (repositories ?? []).flatMap((repo) =>
          repo.skills.flatMap((skill) =>
            skill.missing ? [[skill.skillId, repo.label] as const] : [],
          ),
        ),
      ),
    [repositories],
  );

  useEffect(() => {
    let cancelled = false;
    listMyDefaultSkills()
      .then(({ skillIds, bundleIds }) => {
        if (cancelled) return;
        setSaved(new Set(skillIds));
        setDraft(new Set(skillIds));
        setDefaultBundles(new Set(bundleIds ?? []));
      })
      .catch((reason: unknown) => {
        if (!cancelled)
          setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const skills = useMemo(() => {
    const labels = new Map(devices.map((device) => [device.id, device.label]));
    return catalog.map((skill) => toNormalizedPromotedSkill(skill, labels));
  }, [catalog, devices]);

  const toggle = (skill: NormalizedSkill) =>
    setDraft((current) => {
      const next = new Set(current);
      if (next.has(skill.id)) next.delete(skill.id);
      else next.add(skill.id);
      return next;
    });

  // A bundle default applies at once; skill defaults wait for Save.
  const toggleDefaultBundle = async (id: string) => {
    const next = new Set(defaultBundles);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setError("");
    try {
      const result = await setMyDefaultSkills([...(saved ?? [])], [...next]);
      setDefaultBundles(new Set(result.bundleIds ?? []));
      await onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const { skillIds } = await setMyDefaultSkills([...draft]);
      setSaved(new Set(skillIds));
      setDraft(new Set(skillIds));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageSurface variant="library">
      {error ? (
        <p className="fdy-skill-error" role="alert">
          <AlertTriangle size={13} /> {error}
        </p>
      ) : null}
      <SkillRepositoriesSection
        canManage={canManage}
        defaultBundleIds={defaultBundles}
        deviceTools={deviceTools ?? []}
        devices={devices}
        onToggleDefaultBundle={(id) => void toggleDefaultBundle(id)}
        onAdd={(repository) => setAdding({ repository })}
        onChanged={refresh}
        repositories={repositories}
      />
      <SkillCatalogList
        description={t("library.description")}
        emptyState={{
          title: t("library.emptyTitle"),
          body: t("library.emptyBody"),
        }}
        headerActions={
          catalog.length ? (
            <>
              <span className="fdy-workspace-skills-count">
                {t("library.defaultCount", { count: draft.size })}
              </span>
              <Button
                disabled={!saved || saving || sameSet(saved, draft)}
                onClick={() => void save()}
              >
                {saving
                  ? t("common:actions.saving")
                  : t("library.saveDefaults")}
              </Button>
            </>
          ) : null
        }
        mode="workspace"
        onStatusFilterChange={setStatusFilter}
        onToggleSelect={toggle}
        renderBadges={(skill) => {
          const used = skill.promotedSkill?.usedByWorkspaces ?? [];
          return (
            <>
              {missing.has(skill.id) ? (
                <Badge
                  title={t("library.missingTitle", {
                    label: missing.get(skill.id),
                  })}
                  tone="warn"
                >
                  {t("library.missing")}
                </Badge>
              ) : null}
              {used.length ? (
                <Badge dot={false} title={used.join(", ")} tone="neutral">
                  {t("library.usedBy", { count: used.length })}
                </Badge>
              ) : null}
            </>
          );
        }}
        searchPlaceholder={t("workspace.searchPlaceholder")}
        selectedIds={draft}
        selectionDisabled={!saved || saving}
        skills={skills}
        statusFilterOptions={[
          { value: "all", label: t("workspace.filterAll") },
          { value: "default", label: t("library.filterDefault") },
          { value: "other", label: t("library.filterOther") },
        ]}
        statusFilterPredicate={(skill, value) =>
          value === "all" || (value === "default") === draft.has(skill.id)
        }
        statusFilterValue={statusFilter}
        title={t("library.title")}
      />
      {adding ? (
        <AddRepositoryDialog
          devices={devices}
          onChanged={refresh}
          onClose={() => setAdding(undefined)}
          repository={adding.repository}
        />
      ) : null}
    </PageSurface>
  );
}
