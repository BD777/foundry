import { Alert } from "../../components/ui/alert";
import { ToastFeedback } from "../../components/ui/toast";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  DeviceProjection,
  SkillRepository,
} from "@bd777/foundry-protocol";
import {
  checkSkillRepository,
  followRepositoryAsBundle,
  removeSkillRepository,
  resumeSkillBundle,
} from "../../api";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { RepositoryActions } from "./repository-actions";
import { repositoryHref } from "./recommended-bundles";
import {
  readByLabel,
  RepositorySourceDialog,
  waitingLabel,
} from "./repository-source";
import {
  bundleVersionLabel,
  latestVersionSummary,
  rollbackMenuItems,
} from "./skill-bundle-row";
import { LoadingState } from "../../components/ui/loading";

/**
 * A repository followed by picking skills: what it is, how many of its skills
 * are in the library, the version they follow by themselves, picked skills
 * gone from the repository, and — for admins — one suggested next step with
 * the rest of its actions (rolling back among them) behind "…".
 */
export function SkillPickRow({
  repo,
  canManage,
  busy,
  anyBusy,
  checkError,
  error,
  checkedLabel,
  devices,
  onAdd,
  refresh,
  run,
}: {
  repo: SkillRepository;
  devices: DeviceProjection[];
  /** Reloads the library after the repository's source changed. */
  refresh: () => Promise<void>;
  canManage: boolean;
  /** This row's action is running. */
  busy: boolean;
  /** Some repository action is running. */
  anyBusy: boolean;
  /** Why the last scheduled check failed: shown on the row until one passes. */
  checkError?: string;
  /** What an action on this row failed with (a toast). */
  error?: string;
  checkedLabel: string;
  onAdd: () => void;
  run: (action: () => Promise<unknown>) => void;
}) {
  const { t } = useTranslation(["skills", "common"]);
  const added = repo.skills.length;
  const missing = repo.skills.filter((skill) => skill.missing);
  const summary = latestVersionSummary(repo);
  const names = (skills: SkillRepository["skills"]) =>
    skills.map((skill) => skill.name ?? skill.dir).join(", ");
  const followAsBundle = () => run(() => followRepositoryAsBundle(repo.id));
  const [changingSource, setChangingSource] = useState(false);
  const waiting = waitingLabel(repo);
  return (
    <li className="fdy-skill-repo-row">
      <div className="fdy-skill-repo-copy">
        <span className="fdy-skill-bundle-title">
          {repositoryHref(repo.url, repo) ? (
            <a
              href={repositoryHref(repo.url, repo)}
              rel="noreferrer"
              target="_blank"
            >
              {repo.label}
            </a>
          ) : (
            <span>{repo.label}</span>
          )}
          <Badge dot={false} tone="neutral">
            {t("library.repo.pickedBadge")}
          </Badge>
          {added && repo.version ? (
            <span className="fdy-skill-repo-version">
              {bundleVersionLabel(repo)}
            </span>
          ) : null}
          {repo.paused ? (
            <Badge tone="warn">{t("library.bundle.paused")}</Badge>
          ) : null}
        </span>
        {repo.description ? (
          <p className="fdy-skill-repo-description" title={repo.description}>
            {repo.description}
          </p>
        ) : null}
        <small>
          {[
            repo.foundCount
              ? t("library.repo.pickedOf", {
                  count: added,
                  total: repo.foundCount,
                })
              : t("library.repo.pickedCount", { count: added }),
            added && !repo.paused ? t("library.repo.updatesItself") : "",
            readByLabel(repo),
            checkedLabel,
          ]
            .filter(Boolean)
            .join(" · ")}
        </small>
        {summary ? <small>{summary}</small> : null}
        {waiting ? <small data-tone="warning">{waiting}</small> : null}
        {missing.length ? (
          <small data-tone="warning">
            {t("library.repo.missing", {
              count: missing.length,
              names: names(missing),
            })}
          </small>
        ) : null}
        {added ? (
          <details className="fdy-skill-bundle-members">
            <summary>{t("library.repo.showPicked", { count: added })}</summary>
            <p>{names(repo.skills)}</p>
          </details>
        ) : null}
        {busy ? (
          <LoadingState
            className="fdy-skill-repo-status"
            label={t("library.repo.workingNote")}
          />
        ) : null}
        {checkError ? (
          <Alert
            details={checkError}
            size="compact"
            title={t("library.repo.checkFailed")}
            tone="error"
          />
        ) : null}
        {error ? <ToastFeedback tone="error" title={error} /> : null}
      </div>
      {canManage ? (
        <div className="fdy-skill-repo-actions">
          {repo.paused ? (
            <Button
              disabled={anyBusy}
              onClick={() => run(() => resumeSkillBundle(repo.id))}
              size="sm"
              variant="primary"
            >
              {t("library.bundle.resume")}
            </Button>
          ) : added === 0 ? (
            <Button
              disabled={anyBusy}
              onClick={followAsBundle}
              size="sm"
              variant="primary"
            >
              {busy
                ? t("library.repo.converting")
                : t("library.repo.followWhole")}
            </Button>
          ) : null}
          <RepositoryActions
            disabled={anyBusy}
            items={[
              ...(repo.paused
                ? []
                : [
                    {
                      key: "add",
                      label:
                        added === 0
                          ? t("library.repo.pickInstead")
                          : t("library.repo.addSkills"),
                      onSelect: onAdd,
                    },
                  ]),
              ...(added > 0
                ? [
                    {
                      key: "bundle",
                      label: t("library.repo.followAsBundle"),
                      onSelect: followAsBundle,
                    },
                  ]
                : []),
              ...(repo.paused
                ? []
                : [
                    {
                      key: "check",
                      label: t("library.repo.check"),
                      onSelect: () => run(() => checkSkillRepository(repo.id)),
                    },
                  ]),
              {
                key: "source",
                label: t("library.repo.changeSource"),
                onSelect: () => setChangingSource(true),
              },
              ...rollbackMenuItems(repo, run),
            ]}
            label={repo.label}
            onUnfollow={() => run(() => removeSkillRepository(repo.id))}
            unfollowCopy={t("library.repo.removePickedNote")}
          />
        </div>
      ) : null}
      {changingSource ? (
        <RepositorySourceDialog
          devices={devices}
          onChanged={refresh}
          onClose={() => setChangingSource(false)}
          repo={repo}
        />
      ) : null}
    </li>
  );
}
