import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import type {
  ConnectorPackageView,
  DeviceProjection,
  DeviceTool,
  SkillRepository,
} from "@bd777/foundry-protocol";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { errorText } from "../../lib/errors";
import { dateTime } from "../../lib/time-format";
import { SkillBundleRow } from "./skill-bundle-row";
import { SkillPickRow } from "./skill-pick-row";
import { RecommendedBundles } from "./recommended-bundles";
import { Skeleton } from "../../components/ui/loading";
import { SkillCatalogHeading } from "../../components/skills/skill-catalog-heading";

/**
 * The git repositories and npm packages the library follows, each checked
 * once a day, and — for admins — recommended bundles to add. A bundle and
 * the skills picked from a repository both move to new releases by
 * themselves and can be rolled back.
 */
export function SkillRepositoriesSection({
  repositories,
  canManage,
  devices,
  deviceTools,
  packagesByRepository,
  requestedRepositoryId,
  requestedSkillId,
  defaultBundleIds,
  onToggleDefaultBundle,
  onAdd,
  onChanged,
  loadError,
}: {
  /** Undefined while the first list is loading. */
  repositories: SkillRepository[] | undefined;
  canManage: boolean;
  devices: DeviceProjection[];
  deviceTools: DeviceTool[];
  /** Packages whose followed bundle is a row here, by repository id. */
  packagesByRepository: ReadonlyMap<string, ConnectorPackageView>;
  requestedRepositoryId?: string;
  requestedSkillId?: string;
  defaultBundleIds: Set<string>;
  onToggleDefaultBundle: (id: string) => void;
  /** Opens the add dialog, for a followed repository when given. */
  onAdd: (repository?: SkillRepository) => void;
  onChanged: () => Promise<void>;
  /** Why the list could not be read; it stays empty until it can. */
  loadError?: string;
}) {
  const { t } = useTranslation(["skills", "common"]);
  const [busy, setBusy] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  const run = async (id: string, action: () => Promise<unknown>) => {
    setBusy(id);
    setErrors((current) => ({ ...current, [id]: "" }));
    try {
      await action();
    } catch (cause) {
      setErrors((current) => ({ ...current, [id]: errorText(cause) }));
    } finally {
      await onChanged();
      setBusy("");
    }
  };

  return (
    <section
      className="mb-7 grid gap-3"
      aria-labelledby="fdy-skill-repos-title"
    >
      <SkillCatalogHeading
        actions={
          canManage ? (
            <Button onClick={() => onAdd()} variant="secondary">
              <Plus size={14} />
              {t("library.repo.add")}
            </Button>
          ) : null
        }
        description={t("library.repo.description")}
        title={t("library.repo.title")}
        titleId="fdy-skill-repos-title"
      />
      {repositories === undefined && loadError ? (
        <Alert size="compact" title={loadError} tone="error" />
      ) : repositories === undefined ? (
        <Skeleton label={t("library.repo.loading")} rows={2} variant="rows" />
      ) : repositories.length === 0 ? (
        <p className="text-sm text-ink-muted">
          {canManage ? t("library.repo.empty") : t("library.repo.emptyMember")}
        </p>
      ) : (
        <ul className="grid gap-2">
          {repositories.map((repo) => {
            if (repo.mode === "bundle")
              return (
                <SkillBundleRow
                  busy={busy === repo.id}
                  canManage={canManage}
                  checkedLabel={
                    repo.checkedAt
                      ? t("library.repo.checkedAt", {
                          time: dateTime(repo.checkedAt),
                        })
                      : ""
                  }
                  deviceTools={deviceTools}
                  devices={devices}
                  checkError={repo.error}
                  error={errors[repo.id]}
                  isDefault={defaultBundleIds.has(repo.id)}
                  key={repo.id}
                  packageConnector={packagesByRepository.get(repo.id)}
                  onToggleDefault={() => onToggleDefaultBundle(repo.id)}
                  refresh={onChanged}
                  repo={repo}
                  requested={requestedRepositoryId === repo.id}
                  requestedSkillId={
                    requestedRepositoryId === repo.id
                      ? requestedSkillId
                      : undefined
                  }
                  run={(action) => void run(repo.id, action)}
                />
              );
            return (
              <SkillPickRow
                anyBusy={Boolean(busy)}
                busy={busy === repo.id}
                canManage={canManage}
                checkedLabel={
                  repo.checkedAt
                    ? t("library.repo.checkedAt", {
                        time: dateTime(repo.checkedAt),
                      })
                    : ""
                }
                checkError={repo.error}
                error={errors[repo.id]}
                devices={devices}
                key={repo.id}
                onAdd={() => onAdd(repo)}
                refresh={onChanged}
                repo={repo}
                run={(action) => void run(repo.id, action)}
              />
            );
          })}
        </ul>
      )}
      {canManage && repositories !== undefined ? (
        <RecommendedBundles
          disabled={Boolean(busy)}
          onChanged={onChanged}
          repositories={repositories}
        />
      ) : null}
    </section>
  );
}
