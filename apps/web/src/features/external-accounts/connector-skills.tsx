import type { ConnectorSkillBundle } from "@bd777/foundry-protocol";
import { BookOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AppLink } from "../../components/ui/app-link";
import {
  skillLibraryHref,
  skillLibraryRepositoryHref,
  workspaceSkillsHref,
} from "../../lib/in-app-navigation";

const linkClass =
  "text-ink underline decoration-line underline-offset-2 hover:text-brand";

/**
 * The Skill library bundle that comes with a connector: sessions that
 * receive the connector get the Skills it turns on. Inside a workspace it
 * links to that workspace's Skills page, where more of the bundle can be
 * turned on. Without a followed bundle it says which package the Skill
 * library would follow.
 */
export function ConnectorSkills({
  bundle,
  inWorkspace = false,
}: {
  bundle?: ConnectorSkillBundle;
  inWorkspace?: boolean;
}) {
  const { t } = useTranslation("externalAccounts");
  if (!bundle) return null;
  const partial = bundle.onCount < bundle.skillCount;
  return (
    <span className="fdy-xacc-skills flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs leading-[1.4] text-ink-muted [&>svg]:flex-none [&>svg]:text-ink-faint">
      <BookOpen aria-hidden="true" size={13} />
      {bundle.repositoryId ? (
        <>
          <span>{t("connectorSkills.label")}</span>
          <AppLink
            className={linkClass}
            href={skillLibraryRepositoryHref(bundle.repositoryId)}
          >
            {bundle.name || bundle.package || bundle.kind}
          </AppLink>
          <span>
            {partial
              ? t("connectorSkills.onOf", {
                  on: bundle.onCount,
                  count: bundle.skillCount,
                })
              : t("connectorSkills.count", { count: bundle.skillCount })}
            {bundle.version ? ` · ${bundle.version}` : ""}
          </span>
          <span>{t("connectorSkills.sessionsGet")}</span>
          {partial && inWorkspace ? (
            <AppLink className={linkClass} href={workspaceSkillsHref()}>
              {t("connectorSkills.turnOnMore")}
            </AppLink>
          ) : null}
        </>
      ) : (
        <>
          <span>
            {t("connectorSkills.notFollowed", { package: bundle.package })}
          </span>
          <AppLink className={linkClass} href={skillLibraryHref()}>
            {t("connectorSkills.openLibrary")}
          </AppLink>
        </>
      )}
    </span>
  );
}
