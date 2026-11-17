import type { StatusItem } from "../components/ui/status-indicator";
import type { ToastTone } from "../components/ui/toast";
import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  FoundrySidebar,
  type SidebarNavBadge,
  type SidebarNavItem,
  type SidebarNavSection,
} from "../components/ui/app-shell";
import { useAccountSession } from "./accounts-gate";
import { withAccountNav } from "./account-views";
import { type NavView, type SidebarView } from "../lib/routes";
import { navSections, simpleNavSections, type NavLabel } from "./navigation";
import type { InterfaceMode } from "../lib/assistant-settings-sections";
import { SidebarLanguage } from "./sidebar-language";
import type { ShellPreferences } from "./use-shell-preferences";

export interface AppSidebarProps {
  activeView: NavView;
  assistantName: string;
  /** Simple: only the assistant and its settings (its simpleInterface). */
  interfaceMode: InterfaceMode;
  /** Issues waiting for review, Issues running, and skills on. */
  counts: {
    review: number;
    running: number;
    activeSkills: number;
    /** Open pending items across the person's chats and Issues. */
    pending: number;
    /** An answer in the assistant's home conversation the person has not seen. */
    assistantUnread?: boolean;
  };
  onNavSelect: (view: SidebarView) => void;
  onNotice: (message: string, tone?: ToastTone) => void;
  preferences: ShellPreferences;
  /** Conditions of the whole app (see useAppStatus). */
  status?: readonly StatusItem[];
  workspaceName: string;
  workspaceSelector: ReactNode;
}

/** The badge a nav item shows, from the shell's counts. */
export function navBadge(
  item: SidebarNavItem<SidebarView>,
  counts: AppSidebarProps["counts"],
): SidebarNavBadge | undefined {
  if (item.id === "assistant" && counts.assistantUnread) return { dot: true };
  if (item.id === "issues" && counts.review)
    return { children: counts.review, tone: "brass" };
  if (item.id === "skills")
    return { children: counts.activeSkills, tone: "neutral" };
  if (item.id === "pending" && counts.pending)
    return { children: counts.pending, tone: "brass" };
  return undefined;
}

/** The app's navigation: sections with live counts, theme and language. */
export function AppSidebar({
  activeView,
  assistantName,
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
  const { review, running, activeSkills, pending, assistantUnread } = counts;
  const pageTitle =
    activeView === "workspace" ? t("nav.overview") : t(`views.${activeView}`);
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
            : section.id === "assistant"
              ? t("sidebar.assistantScope", {
                  assistant: assistantName || t("nav.assistantSection"),
                })
              : t("sidebar.globalScope"),
        items: section.items.map((item) => ({
          ...item,
          label:
            section.id === "assistant" && item.id === "assistant"
              ? assistantName || t("nav.assistant")
              : t(`nav.${item.label as NavLabel}`),
          badge: navBadge(item, {
            review,
            running,
            activeSkills,
            pending,
            assistantUnread,
          }),
          liveCount:
            item.id === "issues" && running ? { children: running } : undefined,
        })),
      })),
    [
      account.user?.role,
      assistantName,
      interfaceMode,
      review,
      running,
      activeSkills,
      pending,
      assistantUnread,
      workspaceSelector,
      workspaceName,
      t,
    ],
  );

  return (
    <FoundrySidebar
      activeItemId={
        activeView === "issue"
          ? "issues"
          : activeView === "assistants"
            ? "assistant"
            : activeView
      }
      collapsed={preferences.sidebarCollapsed}
      languageControl={<SidebarLanguage onError={onNotice} />}
      navSections={sections}
      onNavSelect={onNavSelect}
      onThemeToggle={preferences.toggleThemeMode}
      onToggleCollapsed={preferences.toggleSidebarCollapsed}
      pageTitle={pageTitle}
      status={status}
      theme={preferences.themeMode}
    />
  );
}
