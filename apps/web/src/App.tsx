import { useTranslation } from "react-i18next";
import {
  FoundryMain,
  FoundryShell,
  FoundryView,
} from "./components/ui/app-shell";
import { ErrorBoundary } from "./components/ui/error-boundary";
import { WorkspacesFeature } from "./features/workspaces";
import { usePendingItems } from "./features/pending";
import { ActiveView, type AppViewContext } from "./app/active-view";
import { useAppStatus, useTransientNotice } from "./app/app-notices";
import { AppSidebar } from "./app/app-sidebar";
import { scrollModeForView, toastPlacementForView } from "./app/navigation";
import {
  useAppLocation,
  useWorkspaceChoiceRedirect,
} from "./app/use-app-location";
import { useAppRouteSync } from "./app/use-app-route-sync";
import {
  assistantEntryRoute,
  useAssistantRouteResolution,
} from "./app/use-assistant-route-resolution";
import { useAssistantShell } from "./app/use-assistant-shell";
import { useAssistants } from "./app/use-assistants";
import { useChatView } from "./app/use-chat-view";
import { useCurrentWorkspace } from "./app/use-current-workspace";
import { useDocumentTitle } from "./app/use-document-title";
import { useIssueDraftRequest } from "./app/use-issue-draft-request";
import { useShellPreferences } from "./app/use-shell-preferences";
import { storedAssistantId } from "./app/shell-preferences";
import { useViewScrollReset } from "./app/use-view-scroll-reset";
import { useWorkspaceData } from "./app/use-workspace-data";
import { viewErrorLabel, viewErrorResetKey } from "./app/view-error-policy";
import { workspaceFeatureEventHandler } from "./app/workspace-feature-events";
import { needsWorkspaceChoice } from "./app/workspace-selectors";
import { useAccountSession } from "./app/accounts-gate";
import type { SidebarView } from "./lib/routes";

export function App() {
  const { t } = useTranslation("shell");
  const account = useAccountSession();
  const location = useAppLocation();
  const { directory: assistants, reload: reloadAssistants } = useAssistants();
  useAssistantRouteResolution(location, assistants, account.user?.id ?? "");
  const { activeView, selectedChatId, selectedDeviceId, selectedIssueId } =
    location;
  const [, setNotice] = useTransientNotice();
  const preferences = useShellPreferences();
  const workspaceData = useWorkspaceData({
    activeView,
    selectedIssueId,
    setNotice,
    setSelectedChatId: location.setSelectedChatId,
    setSelectedIssueId: location.setSelectedIssueId,
  });
  const { activeWorkspaceId, apiState, data, loadWorkspace } = workspaceData;
  useWorkspaceChoiceRedirect(
    apiState === "connected" && needsWorkspaceChoice(data),
    location,
  );
  const handleWorkspaceEvent = workspaceFeatureEventHandler(
    location,
    workspaceData,
  );

  const assistantShell = useAssistantShell(
    location,
    location.selectedAssistantId,
  );
  const {
    connectorTab,
    setConnectorTab,
    providerTab,
    setProviderTab,
    assistantSection,
    setAssistantSection,
  } = useAppRouteSync({
    activeView,
    activeWorkspaceId,
    onPopState: (route, routeWorkspaceId) => {
      location.showRoute(route);
      if (routeWorkspaceId) {
        void loadWorkspace(routeWorkspaceId, undefined, {
          selectedChatId:
            route.view === "chats" ? (route.selectedChatId ?? "") : undefined,
        });
      }
    },
    selectedChatId,
    selectedAssistantId: location.selectedAssistantId,
    selectedIssueId,
    selectedDeviceId,
    deviceSection: location.deviceSection,
    chatView: location.chatView,
  });
  useViewScrollReset(activeView, selectedIssueId);

  const current = useCurrentWorkspace(data, selectedIssueId);
  const currentAssistant =
    assistants.assistants.find(
      (assistant) => assistant.id === location.selectedAssistantId,
    ) ?? assistants.assistants.find((assistant) => assistant.isDefault);
  useDocumentTitle({
    view: activeView,
    workspaceName: data.workspace.name,
    issue: current.selectedIssue,
    device: data.devices.find((row) => row.id === selectedDeviceId),
  });
  const issueDraft = useIssueDraftRequest(location.setActiveView, setNotice);
  const pending = usePendingItems(apiState !== "loading");
  const viewContext: AppViewContext = {
    current,
    location,
    setNotice,
    workspaceData,
  };
  const chatView = useChatView({
    ...viewContext,
    draftFromSource: issueDraft.draftFromSource,
    pending,
  });

  const viewScrollMode = scrollModeForView(activeView);
  const status = useAppStatus({
    apiState,
    demoFallback: workspaceData.demoFallback,
    onRetry: () => void workspaceData.refreshData({ silent: true }),
  });
  function selectSidebarView(view: SidebarView): void {
    if (view !== "assistant") {
      location.selectSidebarView(view);
      return;
    }
    const entry = assistantEntryRoute(
      assistants.assistants,
      storedAssistantId(account.user?.id ?? ""),
    );
    if (entry.view === "assistant") {
      location.setSelectedAssistantId(entry.assistantId);
      location.setActiveView("assistant");
    } else {
      location.setSelectedAssistantId(undefined);
      location.setActiveView("assistants");
    }
  }

  return (
    <FoundryShell
      scrollMode={viewScrollMode}
      theme={preferences.themeMode}
      toastPlacement={toastPlacementForView(activeView)}
    >
      <AppSidebar
        activeView={activeView}
        assistantName={currentAssistant?.name.trim() ?? ""}
        interfaceMode={assistantShell.interfaceMode}
        counts={{
          review: current.reviewCount,
          running: current.runningCount,
          activeSkills: current.activeSkillCount,
          pending: pending.list?.open ?? 0,
        }}
        onNavSelect={selectSidebarView}
        onNotice={setNotice}
        preferences={preferences}
        status={status}
        workspaceName={data.workspace.name}
        workspaceSelector={
          <WorkspacesFeature
            compact
            collapsed={preferences.sidebarCollapsed}
            activeWorkspaceId={activeWorkspaceId}
            devices={data.devices}
            onEvent={handleWorkspaceEvent}
            workspaces={data.workspaces}
          />
        }
      />

      <FoundryMain>
        <FoundryView scrollMode={viewScrollMode}>
          <ErrorBoundary
            label={viewErrorLabel(activeView)}
            onError={(message) => setNotice(message, "error")}
            resetKey={viewErrorResetKey({
              selectedChatId,
              selectedIssueId,
              selectedDeviceId,
              selectedAssistantId: location.selectedAssistantId,
              view: activeView,
              workspaceId: data.workspace.id,
            })}
            retryLabel={t("notices.reloadView")}
          >
            <ActiveView
              {...viewContext}
              assistantSection={assistantSection}
              assistants={assistants}
              onAssistantsReload={reloadAssistants}
              onAssistantSectionChange={setAssistantSection}
              onInterfaceModeChange={assistantShell.setInterfaceMode}
              chatView={chatView}
              connectorTab={connectorTab}
              issueDraft={issueDraft}
              onConnectorTabChange={setConnectorTab}
              onProviderTabChange={setProviderTab}
              providerTab={providerTab}
              onWorkspaceEvent={handleWorkspaceEvent}
              pending={pending}
            />
          </ErrorBoundary>
        </FoundryView>
      </FoundryMain>
    </FoundryShell>
  );
}
