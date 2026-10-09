import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import type {
  DeviceProjection,
  DeviceTool,
  SkillRepository,
} from "@bd777/foundry-protocol";
import { i18n } from "../../i18n";
import { Button } from "../../components/ui/button";
import { SkillBundleRow } from "./skill-bundle-row";
import { SkillPickRow } from "./skill-pick-row";
import { RecommendedBundles } from "./recommended-bundles";

const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

function checkedLabel(at?: string): string {
  if (!at) return "";
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? at
    : date.toLocaleString(i18n.language, {
        dateStyle: "medium",
        timeStyle: "short",
      });
}

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
  defaultBundleIds,
  onToggleDefaultBundle,
  onAdd,
  onChanged,
}: {
  /** Undefined while the first list is loading. */
  repositories: SkillRepository[] | undefined;
  canManage: boolean;
  devices: DeviceProjection[];
  deviceTools: DeviceTool[];
  defaultBundleIds: Set<string>;
  onToggleDefaultBundle: (id: string) => void;
  /** Opens the add dialog, for a followed repository when given. */
  onAdd: (repository?: SkillRepository) => void;
  onChanged: () => Promise<void>;
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
      className="fdy-skill-repos"
      aria-labelledby="fdy-skill-repos-title"
    >
      <header className="fdy-skill-catalog-heading">
        <div className="fdy-skill-catalog-heading-copy">
          <h2 id="fdy-skill-repos-title">{t("library.repo.title")}</h2>
          <p>{t("library.repo.description")}</p>
        </div>
        {canManage ? (
          <div className="fdy-skill-catalog-heading-actions">
            <Button onClick={() => onAdd()} variant="secondary">
              <Plus size={14} />
              {t("library.repo.add")}
            </Button>
          </div>
        ) : null}
      </header>
      {repositories === undefined ? (
        <p className="fdy-skill-repos-empty" role="status">
          {t("library.repo.loading")}
        </p>
      ) : repositories.length === 0 ? (
        <p className="fdy-skill-repos-empty">
          {canManage ? t("library.repo.empty") : t("library.repo.emptyMember")}
        </p>
      ) : (
        <ul className="fdy-skill-repo-list">
          {repositories.map((repo) => {
            if (repo.mode === "bundle")
              return (
                <SkillBundleRow
                  busy={busy === repo.id}
                  canManage={canManage}
                  checkedLabel={
                    repo.checkedAt
                      ? t("library.repo.checkedAt", {
                          time: checkedLabel(repo.checkedAt),
                        })
                      : ""
                  }
                  deviceTools={deviceTools}
                  devices={devices}
                  error={errors[repo.id] || repo.error}
                  isDefault={defaultBundleIds.has(repo.id)}
                  key={repo.id}
                  onToggleDefault={() => onToggleDefaultBundle(repo.id)}
                  refresh={onChanged}
                  repo={repo}
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
                        time: checkedLabel(repo.checkedAt),
                      })
                    : ""
                }
                error={errors[repo.id] || repo.error}
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
