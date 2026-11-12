import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ActionRow } from "../../components/ui/action-row";
import { AppLink } from "../../components/ui/app-link";
import { NavGroup, NavItem } from "../../components/ui/nav-list";
import {
  assistantSettingsGroups,
  type AssistantSettingsSection,
} from "../../lib/assistant-settings-sections";
import { pathForAppRoute } from "../../lib/routes";

function settingsHref(
  assistantId: string | undefined,
  section: AssistantSettingsSection,
): string {
  return pathForAppRoute({
    view: "assistantSettings",
    assistantId,
    assistantSection: section,
  });
}

export interface AssistantSettingsNavProps {
  assistantId?: string;
  selected: AssistantSettingsSection;
  onSelect: (section: AssistantSettingsSection) => void;
  /** Shows the full-width section index below the wide breakpoint. */
  showIndex: boolean;
}

/**
 * Settings navigation: a grouped rail at wide widths and a section index on
 * narrow screens. Every row is a real link, so history and new-tab behavior
 * match the rest of the app.
 */
export function AssistantSettingsNav({
  assistantId,
  selected,
  onSelect,
  showIndex,
}: AssistantSettingsNavProps) {
  const { t } = useTranslation("personalAgent");

  return (
    <>
      <nav
        aria-label={t("settings.sectionsLabel")}
        className="hidden xl:block"
        data-assistant-settings-nav="desktop"
      >
        {assistantSettingsGroups.map((group) => (
          <NavGroup key={group.id} label={t(`settings.groups.${group.id}`)}>
            {group.sections.map((section) => (
              <NavItem
                asChild
                current={section === selected}
                key={section}
                tone="surface"
              >
                <AppLink
                  href={settingsHref(assistantId, section)}
                  onClick={() => onSelect(section)}
                >
                  <span className="min-w-0 flex-1 truncate text-left">
                    {t(`settings.sections.${section}`)}
                  </span>
                </AppLink>
              </NavItem>
            ))}
          </NavGroup>
        ))}
      </nav>

      {showIndex ? (
        <nav
          aria-label={t("settings.sectionsLabel")}
          className="xl:hidden"
          data-assistant-settings-nav="index"
        >
          {assistantSettingsGroups.map((group) => (
            <NavGroup key={group.id} label={t(`settings.groups.${group.id}`)}>
              {group.sections.map((section) => (
                <ActionRow asChild density="compact" key={section}>
                  <AppLink
                    className="flex w-full items-center justify-start gap-3 text-md"
                    href={settingsHref(assistantId, section)}
                    onClick={() => onSelect(section)}
                  >
                    <span className="grid min-w-0 flex-1 gap-0.5">
                      <span className="font-semibold text-ink">
                        {t(`settings.sections.${section}`)}
                      </span>
                      <span className="truncate text-xs leading-[1.4] text-ink-muted">
                        {t(`settings.hints.${section}`)}
                      </span>
                    </span>
                    <ChevronRight
                      aria-hidden="true"
                      className="flex-none text-ink-faint"
                      size={16}
                    />
                  </AppLink>
                </ActionRow>
              ))}
            </NavGroup>
          ))}
        </nav>
      ) : null}
    </>
  );
}
