import { useState } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "../../i18n";
import type {
  DeviceProjection,
  DeviceTool,
  SkillRepository,
} from "@bd777/foundry-protocol";
import {
  checkSkillRepository,
  installDeviceTool,
  removeSkillRepository,
  resumeSkillBundle,
  rollbackSkillBundle,
} from "../../api";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/field";
import { BundleToolStatus } from "./bundle-tool-status";
import {
  RepositoryActions,
  type RepositoryMenuItem,
} from "./repository-actions";
import { repositoryHref } from "./recommended-bundles";
import {
  readByLabel,
  RepositorySourceDialog,
  waitingLabel,
} from "./repository-source";

/** Earlier versions offered to roll back to, newest first. */
const rollbackChoices = 5;

/** A repository with no release is followed by its short commit. */
const isShortCommit = (version: string) => /^[0-9a-f]{7}$/.test(version);

/** A version as people read it: a release tag, or "commit abc1234". */
function versionName(tag: string): string {
  return isShortCommit(tag)
    ? i18n.t("skills:library.bundle.commit", { commit: tag })
    : tag;
}

/**
 * The version a bundle runs, saying what it follows: a release tag, a
 * branch's commit, or (with no release) the default branch's commit. A
 * rolled-back repository holds an earlier release, so it is not called the
 * latest.
 */
export function bundleVersionLabel(
  repo: Pick<SkillRepository, "ref" | "version" | "paused">,
): string {
  const version = repo.version ?? "";
  if (repo.ref)
    return i18n.t("skills:library.bundle.branchVersion", { version });
  if (isShortCommit(version))
    return i18n.t("skills:library.bundle.defaultBranchVersion", { version });
  if (repo.paused) return version;
  return i18n.t("skills:library.repo.latestRelease", { tag: version });
}

/**
 * What a repository's latest version did, in one line: "Updated to v1.2 ·
 * 1 changed · 1 added", or the version it was rolled back to.
 */
export function latestVersionSummary(
  repo: Pick<SkillRepository, "versions">,
): string {
  const latest = repo.versions?.[0];
  if (!latest) return "";
  const count = (
    key: "changed" | "added" | "removed" | "missing",
    items?: string[],
  ) =>
    items?.length
      ? i18n.t(`skills:library.bundle.${key}`, { count: items.length })
      : "";
  const tag = versionName(latest.tag);
  return [
    latest.rolledBack
      ? i18n.t("skills:library.bundle.rolledBackTo", { tag })
      : i18n.t("skills:library.bundle.updatedTo", { tag }),
    count("changed", latest.changed),
    count("added", latest.added),
    count("removed", latest.removed),
    count("missing", latest.missing),
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * "Roll back to …" menu items for a repository's earlier versions: each
 * commit once, and never the one it runs now (after a rollback, that is an
 * earlier entry).
 */
export function rollbackMenuItems(
  repo: Pick<SkillRepository, "id" | "versions">,
  run: (action: () => Promise<unknown>) => void,
): RepositoryMenuItem[] {
  const seen = new Set(repo.versions?.[0] ? [repo.versions[0].commit] : []);
  return (repo.versions ?? [])
    .filter((version) => {
      if (version.rolledBack || seen.has(version.commit)) return false;
      seen.add(version.commit);
      return true;
    })
    .slice(0, rollbackChoices)
    .map((version) => ({
      key: `rollback-${version.seq}`,
      label: i18n.t("skills:library.bundle.rollbackTo", {
        tag: versionName(version.tag),
      }),
      onSelect: () => run(() => rollbackSkillBundle(repo.id, version.seq)),
    }));
}

/**
 * A repository followed as one bundle: its version, what the last update
 * changed, its skills, the program it needs on each device, and — for
 * admins — checking, rolling back, resuming and unfollowing.
 */
export function SkillBundleRow({
  repo,
  canManage,
  busy,
  error,
  checkedLabel,
  devices,
  deviceTools,
  isDefault,
  onToggleDefault,
  refresh,
  run,
}: {
  repo: SkillRepository;
  canManage: boolean;
  busy: boolean;
  error?: string;
  checkedLabel: string;
  devices: DeviceProjection[];
  deviceTools: DeviceTool[];
  isDefault: boolean;
  onToggleDefault: () => void;
  /** Reloads the library after an install, without busying the card. */
  refresh: () => Promise<void>;
  run: (action: () => Promise<unknown>) => void;
}) {
  const { t } = useTranslation(["skills", "common"]);
  const current = repo.skills.filter((skill) => !skill.retired);
  const summary = latestVersionSummary(repo);
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
              {repo.name || repo.label}
            </a>
          ) : (
            <span>{repo.name || repo.label}</span>
          )}
          <Badge dot={false} tone="neutral">
            {t("library.bundle.badge")}
          </Badge>
          {repo.version ? (
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
            t("library.repo.skillCount", { count: current.length }),
            t("library.bundle.from", { label: repo.label }),
            readByLabel(repo),
            checkedLabel,
          ]
            .filter(Boolean)
            .join(" · ")}
        </small>
        {summary ? <small>{summary}</small> : null}
        {waiting ? <small data-tone="warning">{waiting}</small> : null}
        {current.length ? (
          <details className="fdy-skill-bundle-members">
            <summary>
              {t("library.bundle.showSkills", { count: current.length })}
            </summary>
            <p>{current.map((skill) => skill.name ?? skill.dir).join(", ")}</p>
          </details>
        ) : null}
        {(repo.tools ?? []).map((tool) => (
          <BundleToolStatus
            deviceTools={deviceTools}
            devices={devices}
            disabled={busy}
            install={async (device) => {
              await installDeviceTool(device.id, repo.id, tool.name);
              await refresh();
            }}
            key={tool.name}
            setup={async (device) =>
              (await installDeviceTool(device.id, repo.id, tool.name, "setup"))
                .output ?? ""
            }
            tool={tool}
          />
        ))}
        <label className="fdy-skill-bundle-default">
          <Checkbox
            aria-label={t("library.bundle.defaultFor", {
              name: repo.name || repo.label,
            })}
            checked={isDefault}
            onChange={onToggleDefault}
          />
          {t("library.bundle.default")}
        </label>
        {busy ? (
          <p className="fdy-skill-repo-status" role="status">
            {t("library.bundle.working")}
          </p>
        ) : null}
        {error ? (
          <p className="fdy-skill-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      {canManage ? (
        <div className="fdy-skill-repo-actions">
          {repo.paused ? (
            <Button
              disabled={busy}
              onClick={() => run(() => resumeSkillBundle(repo.id))}
              size="sm"
              variant="primary"
            >
              {t("library.bundle.resume")}
            </Button>
          ) : null}
          <RepositoryActions
            disabled={busy}
            items={[
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
            label={repo.name || repo.label}
            onUnfollow={() => run(() => removeSkillRepository(repo.id))}
            unfollowCopy={t("library.repo.removeBundleNote")}
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
