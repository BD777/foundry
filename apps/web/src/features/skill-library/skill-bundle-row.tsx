import { ChevronDown, PackageOpen } from "lucide-react";
import { ToastFeedback } from "../../components/ui/toast";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "../../i18n";
import type {
  ConnectorPackageView,
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
import { AppLink } from "../../components/ui/app-link";
import { Button } from "../../components/ui/button";
import { Switch } from "../../components/ui/switch";
import { BundleToolStatus } from "./bundle-tool-status";
import {
  BundlePolicyControl,
  BundlePolicyHint,
  BundleRolloutSection,
  BundleUpdateNotice,
  isShortCommit,
  namerFor,
  VersionHistory,
  versionName,
} from "./bundle-rollout";
import { RepositoryCheckError } from "./repository-check-error";
import {
  bundleStatus,
  rolloutShown,
  type BundleStatus,
} from "../../lib/bundle-versions";
import {
  BundleStateBadge,
  type BundleStateLook,
} from "../../components/skills/bundle-state-badge";
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
import { LoadingState } from "../../components/ui/loading";
import { BundleTitle } from "../../components/skills/skill-bundle-title";
import { SkillNote } from "../../components/skills/skill-note";
import {
  RepositoryButtons,
  RepositoryCopy,
  RepositoryDescription,
  RepositoryName,
  RepositoryRow,
} from "./repository-row";
import { connectorsHref } from "../../lib/in-app-navigation";

/** Earlier versions offered to roll back to, newest first. */
const rollbackChoices = 5;

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

/** The words of a bundle's status chip. */
function statusWords(status: BundleStatus): string {
  switch (status.kind) {
    case "updating":
      return i18n.t("skills:library.bundle.status.updating", {
        updated: status.updated,
        total: status.total,
      });
    default:
      return i18n.t(`skills:library.bundle.status.${status.kind}`);
  }
}

const statusLook: Record<BundleStatus["kind"], BundleStateLook> = {
  paused: "paused",
  updating: "working",
  updateFailed: "failed",
  checkFailed: "failed",
  updateAvailable: "update",
  upToDate: "ok",
};

/**
 * A repository followed as one bundle, read top to bottom: its name,
 * version and one status; where it comes from; why its last check failed;
 * one row of facts (skills, installs, how it updates, default for my
 * workspaces); then a running or just-finished rollout and the version
 * history. Admins check, roll back, resume and unfollow from the header.
 */
export function SkillBundleRow({
  repo,
  canManage,
  busy,
  checkError,
  error,
  checkedLabel,
  devices,
  deviceTools,
  isDefault,
  onToggleDefault,
  refresh,
  run,
  packageConnector,
  requested = false,
  requestedSkillId,
}: {
  repo: SkillRepository;
  canManage: boolean;
  busy: boolean;
  /** Why the last scheduled check failed: shown on the row until one passes. */
  checkError?: string;
  /** What an action on this row failed with (a toast). */
  error?: string;
  checkedLabel: string;
  devices: DeviceProjection[];
  deviceTools: DeviceTool[];
  isDefault: boolean;
  onToggleDefault: () => void;
  /** Reloads the library after an install, without busying the card. */
  refresh: () => Promise<void>;
  run: (action: () => Promise<unknown>) => void;
  /** The person-level package whose followed bundle this is. */
  packageConnector?: ConnectorPackageView;
  /** A link from that connector asked the library to show this bundle. */
  requested?: boolean;
  requestedSkillId?: string;
}) {
  const { t } = useTranslation(["skills", "common"]);
  const current = repo.skills.filter((skill) => !skill.retired);
  const latest = latestVersionSummary(repo);
  const [changingSource, setChangingSource] = useState(false);
  const [showingSkills, setShowingSkills] = useState(requested);
  const skillsId = useId();
  const defaultId = useId();
  const waiting = waitingLabel(repo);
  const name = repo.name || repo.label;
  const status = bundleStatus(repo, checkError);
  const namer = namerFor(devices);
  const tools = repo.tools ?? [];
  useEffect(() => {
    if (!requested) return;
    setShowingSkills(true);
    const id = `skill-bundle-${repo.id}`;
    requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView?.({ block: "center" });
    });
  }, [repo.id, requested, requestedSkillId]);
  const connectorName = packageConnector
    ? i18n.language.startsWith("zh")
      ? (packageConnector.connector.labels?.["zh-CN"] ??
        packageConnector.connector.label)
      : packageConnector.connector.label
    : "";
  return (
    <RepositoryRow
      className={requested ? "ring-2 ring-brand/35" : undefined}
      id={`skill-bundle-${repo.id}`}
    >
      <RepositoryCopy className="gap-1.5">
        <BundleTitle>
          <RepositoryName href={repositoryHref(repo.url, repo)}>
            {name}
          </RepositoryName>
          {repo.version ? (
            <Badge className="font-mono" dot={false} tone="neutral">
              {bundleVersionLabel({ ...repo, paused: true })}
            </Badge>
          ) : null}
          <BundleStateBadge
            look={
              status.kind === "updating" && !status.moving
                ? "waiting"
                : statusLook[status.kind]
            }
          >
            {statusWords(status)}
          </BundleStateBadge>
        </BundleTitle>
        <SkillNote>
          {[
            t("library.bundle.from", { label: repo.label }),
            readByLabel(repo),
            checkedLabel,
          ]
            .filter(Boolean)
            .join(" · ")}
        </SkillNote>
        {packageConnector ? (
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-ink-muted">
            <PackageOpen
              aria-hidden="true"
              className="flex-none text-ink-faint"
              size={14}
            />
            <AppLink
              className="font-medium text-ink underline underline-offset-2 hover:text-brand"
              href={connectorsHref(packageConnector.connector.kind)}
            >
              {t("library.bundle.connector", { name: connectorName })}
            </AppLink>
          </div>
        ) : null}
        {repo.description ? (
          <RepositoryDescription title={repo.description}>
            {repo.description}
          </RepositoryDescription>
        ) : null}
        {waiting ? <SkillNote data-tone="warning">{waiting}</SkillNote> : null}
        {checkError ? (
          <RepositoryCheckError
            busy={busy}
            error={checkError}
            onRetry={
              canManage && !repo.paused
                ? () => run(() => checkSkillRepository(repo.id))
                : undefined
            }
          />
        ) : null}
        <div className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-2 pt-0.5">
          {current.length ? (
            <Button
              aria-controls={skillsId}
              aria-expanded={showingSkills}
              aria-label={t("library.bundle.facts.skillsToggle", { name })}
              className="-ml-2"
              onClick={() => setShowingSkills((shown) => !shown)}
              size="sm"
              variant="ghost"
            >
              {t("library.bundle.facts.skills", { count: current.length })}
              <ChevronDown
                aria-hidden="true"
                className={
                  showingSkills
                    ? "rotate-180 transition-transform duration-150"
                    : "transition-transform duration-150"
                }
                size={14}
              />
            </Button>
          ) : null}
          {tools.map((tool) => (
            <BundleToolStatus
              deviceTools={deviceTools}
              devices={devices}
              disabled={busy}
              install={async (device) => {
                await installDeviceTool(device.id, repo.id, tool.name);
                await refresh();
              }}
              key={tool.name}
              named={tools.length > 1}
              repo={repo}
              setup={async (device) =>
                (
                  await installDeviceTool(
                    device.id,
                    repo.id,
                    tool.name,
                    "setup",
                  )
                ).output ?? ""
              }
              tool={tool}
            />
          ))}
          {tools.length ? (
            <BundlePolicyControl
              busy={busy}
              canManage={canManage}
              repo={repo}
              run={run}
            />
          ) : null}
          <div className="flex items-center gap-2">
            <Switch
              aria-label={t("library.bundle.defaultFor", { name })}
              checked={isDefault}
              id={defaultId}
              onCheckedChange={onToggleDefault}
            />
            <label
              className="cursor-pointer text-sm text-ink"
              htmlFor={defaultId}
            >
              {t("library.bundle.facts.default")}
            </label>
          </div>
        </div>
        {tools.length ? <BundlePolicyHint repo={repo} /> : null}
        {showingSkills ? (
          <div className="grid min-w-0 gap-1" id={skillsId}>
            <ul className="m-0 grid min-w-0 list-none gap-1 p-0">
              {current.map((skill) => {
                const linked = skill.skillId === requestedSkillId;
                return (
                  <li
                    className="flex min-w-0 flex-wrap items-center gap-2 text-xs"
                    key={skill.skillId}
                  >
                    <span
                      aria-current={linked ? "location" : undefined}
                      className={
                        linked
                          ? "font-semibold text-ink"
                          : "text-ink-muted [overflow-wrap:anywhere]"
                      }
                    >
                      {skill.name ?? skill.dir}
                    </span>
                    {linked ? (
                      <Badge dot={false} size="xs" tone="slate">
                        {t("library.bundle.linkedSkill")}
                      </Badge>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
        {tools.length ? (
          <BundleUpdateNotice
            busy={busy}
            canManage={canManage}
            repo={repo}
            run={run}
          />
        ) : null}
        {rolloutShown(repo.rollout) ? (
          <BundleRolloutSection
            name={namer}
            paused={Boolean(repo.paused)}
            rollout={repo.rollout}
          />
        ) : null}
        <VersionHistory latest={latest} name={namer} repo={repo} />
        {busy ? (
          <LoadingState
            className="m-0 text-sm text-ink-muted"
            label={t("library.bundle.working")}
          />
        ) : null}
        {error ? <ToastFeedback tone="error" title={error} /> : null}
      </RepositoryCopy>
      {canManage ? (
        <RepositoryButtons>
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
            label={name}
            onUnfollow={() => run(() => removeSkillRepository(repo.id))}
            unfollowCopy={t("library.repo.removeBundleNote")}
          />
        </RepositoryButtons>
      ) : null}
      {changingSource ? (
        <RepositorySourceDialog
          devices={devices}
          onChanged={refresh}
          onClose={() => setChangingSource(false)}
          repo={repo}
        />
      ) : null}
    </RepositoryRow>
  );
}
