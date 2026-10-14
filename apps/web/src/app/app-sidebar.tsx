import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  FoundrySidebar,
  type SidebarNavSection,
} from "../components/ui/app-shell";
import { useAccountSession } from "./accounts-gate";
import { withAccountNav } from "./account-views";
import {
  navSections,
  simpleNavSections,
  type NavLabel,
  type NavView,
  type SidebarView,
} from "./navigation";
import type { InterfaceMode } from "../lib/assistant-settings-sections";
import { SidebarLanguage } from "./sidebar-language";
import type { ShellPreferences } from "./use-shell-preferences";

export interface AppSidebarProps {
  activeView: NavView;
  /** Simple: only the assistant and its settings (its simpleInterface). */
  interfaceMode: InterfaceMode;
  /** Issues waiting for review, Issues running, and skills on. */
  counts: { review: number; running: number; activeSkills: number };
  onNavSelect: (view: SidebarView) => void;
  onNotice: (message: string) => void;
  preferences: ShellPreferences;
  workspaceName: string;
  workspaceSelector: ReactNode;
}

/** The app's navigation: sections with live counts, theme and language. */
export function AppSidebar({
  activeView,
  interfaceMode,
  counts,
  onNavSelect,
  onNotice,
  preferences,
  workspaceName,
  workspaceSelector,
}: AppSidebarProps) {
  const account = useAccountSession();
  const { t } = useTranslation("shell");
  const { review, running, activeSkills } = counts;
  const sections = useMemo<Array<SidebarNavSection<SidebarView>>>(
    () =>
      withAccountNav(
        interfaceMode === "simple" ? simpleNavSections : navSections,
        account.user?.role,
      ).map((section) => ({
        ...section,
        label: t(`nav.${section.label as NavLabel}`),
        items: section.items.map((item) => ({
          ...item,
          label: t(`nav.${item.label as NavLabel}`),
          badge:
            item.id === "issues" && review
              ? { children: review, tone: "brass" }
              : item.id === "skills"
                ? { children: activeSkills, tone: "neutral" }
                : undefined,
          liveCount:
            item.id === "issues" && running ? { children: running } : undefined,
        })),
      })),
    [account.user?.role, interfaceMode, review, running, activeSkills],
  );

  return (
    <FoundrySidebar
      activeItemId={activeView === "issue" ? "issues" : activeView}
      collapsed={preferences.sidebarCollapsed}
      languageControl={<SidebarLanguage onError={onNotice} />}
      navSections={sections}
      onNavSelect={onNavSelect}
      onThemeToggle={preferences.toggleThemeMode}
      onToggleCollapsed={preferences.toggleSidebarCollapsed}
      theme={preferences.themeMode}
      workspaceName={interfaceMode === "simple" ? "" : workspaceName}
      workspaceSelector={
        interfaceMode === "simple" ? undefined : workspaceSelector
      }
    />
  );
}
