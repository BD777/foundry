import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SkillRepository } from "@bd777/foundry-protocol";
import { listSkillRepositories } from "../../api";
import {
  bundleDeviceStatus,
  bundleDeviceStatusLabel,
  bundleForCommand,
  connectorDeviceLine,
  rolloutRunning,
  rolloutSummary,
} from "../../lib/bundle-versions";
import { skillLibraryHref } from "../../lib/in-app-navigation";
import { AppLink } from "../../components/ui/app-link";
import { MutedText } from "../../components/ui/text";
import {
  BundleStateBadge,
  deviceStatusLook,
} from "../../components/skills/bundle-state-badge";

/**
 * Where the connector's CLI stands on each device against the skills its
 * sessions get, read-only: one line per device the bundle reached, and a
 * link to the bundle in the Skill Library, where versions are managed.
 * Nothing shows when no followed bundle carries the command.
 */
export function ConnectorBundleVersions({
  command,
  deviceName,
}: {
  /** The connector's program, e.g. "feishu-cli". */
  command: string;
  /** Names a device the page knows. */
  deviceName: (deviceId: string) => string | undefined;
}) {
  const { t } = useTranslation("externalAccounts");
  const [repo, setRepo] = useState<SkillRepository>();

  useEffect(() => {
    let cancelled = false;
    // A detail: the tab stands without it.
    listSkillRepositories().then(
      (repositories) => {
        if (!cancelled) setRepo(bundleForCommand(repositories, command));
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [command]);

  const versions = (repo?.deviceVersions ?? []).filter(
    (entry) => entry.tools[command] !== undefined,
  );
  if (!repo || !versions.length) return null;
  const name = (id: string) =>
    deviceName(id) ??
    repo.rollout?.devices.find((device) => device.deviceId === id)
      ?.deviceName ??
    id;
  return (
    <section
      aria-label={t("feishu.versions.label", { command })}
      className="grid min-w-0 gap-1.5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <MutedText as="span" size="sm" tone="ink">
          {t("feishu.versions.title", { command })}
        </MutedText>
        <AppLink
          className="text-xs text-ink-muted underline underline-offset-2 hover:text-ink"
          href={skillLibraryHref()}
        >
          {t("feishu.versions.manage")}
        </AppLink>
      </div>
      {rolloutRunning(repo.rollout) && repo.rollout ? (
        <MutedText>{rolloutSummary(repo.rollout, name)}</MutedText>
      ) : null}
      <ul className="grid min-w-0 gap-1">
        {versions.map((version) => {
          const status = bundleDeviceStatus(version, repo);
          return (
            <li
              className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5"
              key={version.deviceId}
            >
              <BundleStateBadge look={deviceStatusLook[status]}>
                {bundleDeviceStatusLabel(status)}
              </BundleStateBadge>
              <MutedText as="span">
                {connectorDeviceLine(
                  version,
                  command,
                  name(version.deviceId),
                  repo,
                  false,
                )}
              </MutedText>
              {status === "mismatch" ? (
                <MutedText as="span" tone="warning">
                  {t("feishu.versions.mismatch")}
                </MutedText>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
