import type { StatusItem } from "../components/ui/status-indicator";
import type { ToastTone } from "../components/ui/toast";
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
  counts: {
    review: number;
    running: number;
    activeSkills: number;
    /** Open pending items across the person's chats and Issues. */
    pending: number;
  };
  onNavSelect: (view: SidebarView) => void;
  onNotice: (message: string, tone?: ToastTone) => void;
  preferences: ShellPreferences;
  /** Conditions of the whole app (see useAppStatus). */
  status?: readonly StatusItem[];
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
  status,
  workspaceName,
  workspaceSelector,
}: AppSidebarProps) {
  const account = useAccountSession();
  const { t } = useTranslation("shell");
  const { review, running, activeSkills, pending } = counts;
  const sections = useMemo<Array<SidebarNavSection<SidebarView>>>(
    () =>
      withAccountNav(
        interfaceMode === "simple" ? simpleNavSections : navSections,
        account.user?.role,
      ).map((section) => ({
        ...section,
        label: t(`nav.${section.label as NavLabel}`),
        header: section.id === "workspace" ? workspaceSelector : undefined,
        scopeLabel:
          section.id === "workspace"
            ? t("sidebar.workspaceScope", {
                workspace: workspaceName || t("nav.workspace"),
              })
            : t("sidebar.globalScope"),
        items: section.items.map((item) => ({
          ...item,
          label: t(`nav.${item.label as NavLabel}`),
          badge:
            item.id === "issues" && review
              ? { children: review, tone: "brass" }
              : item.id === "skills"
                ? { children: activeSkills, tone: "neutral" }
                : item.id === "pending" && pending
                  ? { children: pending, tone: "brass" }
                  : undefined,
          liveCount:
            item.id === "issues" && running ? { children: running } : undefined,
        })),
      })),
    [
      account.user?.role,
      interfaceMode,
      review,
      running,
      activeSkills,
      pending,
      workspaceSelector,
      workspaceName,
      t,
    ],
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
      status={status}
      theme={preferences.themeMode}
    />
  );
}
