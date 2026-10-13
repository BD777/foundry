import { useTranslation } from "react-i18next";
import {
  FoundryMain,
  FoundryShell,
  FoundryView,
} from "./components/ui/app-shell";
import { ErrorBoundary } from "./components/ui/error-boundary";
import { WorkspacesFeature } from "./features/workspaces";
import { ActiveView, type AppViewContext } from "./app/active-view";
import { AppNotices, useTransientNotice } from "./app/app-notices";
import { AppSidebar } from "./app/app-sidebar";
import { scrollModeForView } from "./app/navigation";
import {
  useAppLocation,
  useWorkspaceChoiceRedirect,
} from "./app/use-app-location";
import { useAppRouteSync } from "./app/use-app-route-sync";
import { useChatView } from "./app/use-chat-view";
import { useCurrentWorkspace } from "./app/use-current-workspace";
import { useDocumentTitle } from "./app/use-document-title";
import { useIssueDraftRequest } from "./app/use-issue-draft-request";
import { useShellPreferences } from "./app/use-shell-preferences";
import { useViewScrollReset } from "./app/use-view-scroll-reset";
import { useWorkspaceData } from "./app/use-workspace-data";
import { viewErrorLabel, viewErrorResetKey } from "./app/view-error-policy";
import { workspaceFeatureEventHandler } from "./app/workspace-feature-events";
import { needsWorkspaceChoice } from "./app/workspace-selectors";

export function App() {
  const { t } = useTranslation("shell");
  const location = useAppLocation();
  const { activeView, selectedChatId, selectedDeviceId, selectedIssueId } =
    location;
  const [notice, setNotice] = useTransientNotice();
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

  const { connectorTab, setConnectorTab } = useAppRouteSync({
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
    selectedIssueId,
    selectedDeviceId,
    deviceSection: location.deviceSection,
  });
  useViewScrollReset(activeView, selectedIssueId);

  const current = useCurrentWorkspace(data, selectedIssueId);
  useDocumentTitle({
    view: activeView,
    workspaceName: data.workspace.name,
    issue: current.selectedIssue,
    device: data.devices.find((row) => row.id === selectedDeviceId),
  });
  const issueDraft = useIssueDraftRequest(location.setActiveView, setNotice);
  const viewContext: AppViewContext = {
    current,
    location,
    setNotice,
    workspaceData,
  };
  const chatView = useChatView({
    ...viewContext,
    draftFromSource: issueDraft.draftFromSource,
  });

  const viewScrollMode = scrollModeForView(activeView);

  return (
    <FoundryShell scrollMode={viewScrollMode} theme={preferences.themeMode}>
      <AppSidebar
        activeView={activeView}
        counts={{
          review: current.reviewCount,
          running: current.runningCount,
          activeSkills: current.activeSkillCount,
        }}
        onNavSelect={location.selectSidebarView}
        onNotice={setNotice}
        preferences={preferences}
        workspaceName={data.workspace.name}
        workspaceSelector={
          <WorkspacesFeature
            compact
            activeWorkspaceId={activeWorkspaceId}
            devices={data.devices}
            onEvent={handleWorkspaceEvent}
            workspaces={data.workspaces}
          />
        }
      />

      <FoundryMain>
        <AppNotices
          apiState={apiState}
          demoFallback={workspaceData.demoFallback}
          notice={notice}
        />
        <FoundryView scrollMode={viewScrollMode}>
          <ErrorBoundary
            label={viewErrorLabel(activeView)}
            onError={setNotice}
            resetKey={viewErrorResetKey({
              selectedChatId,
              selectedIssueId,
              selectedDeviceId,
              view: activeView,
              workspaceId: data.workspace.id,
            })}
            retryLabel={t("notices.reloadView")}
          >
            <ActiveView
              {...viewContext}
              chatView={chatView}
              connectorTab={connectorTab}
              issueDraft={issueDraft}
              onConnectorTabChange={setConnectorTab}
              onWorkspaceEvent={handleWorkspaceEvent}
            />
          </ErrorBoundary>
        </FoundryView>
      </FoundryMain>
    </FoundryShell>
  );
}
