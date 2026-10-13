import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FoundryMain,
  FoundrySidebar,
  FoundryShell,
  FoundryView,
  NoticeLine,
  NoticeStack,
  type FoundryThemeMode,
  type SidebarNavSection,
} from "./components/ui/app-shell";
import {
  initialDevicePairingMode,
  clearWorkspaceSelection,
  parseAppRoute,
  persistSidebarCollapsed,
  persistThemeMode,
  navSections,
  type NavLabel,
  scrollModeForView,
  storedSidebarCollapsed,
  storedThemeMode,
  workspaceScopedViews,
  type AppRoute,
  type DevicePairingMode,
  type NavView,
  type SidebarView,
} from "./app/navigation";
import { workspaceComposerSkills } from "./app/composer-skills";
import {
  assetsViewFields,
  devicesViewFields,
  libraryViewFields,
  profilesViewFields,
  skillsViewFields,
  workspacesViewFields,
} from "./app/view-fields";
import { useDocumentTitle } from "./app/use-document-title";
import { NewBuildNotice } from "./app/deployed-build";
import {
  withSessionDetails,
  useRemovedChatSelection,
} from "./app/loaded-foundry-data";
import {
  currentDevice,
  currentProviderHealth,
  currentWorkspaceAgents,
  currentWorkspaceAssets,
  currentWorkspaceItems,
  needsWorkspaceChoice,
  workspaceActiveSkillIds,
} from "./app/workspace-selectors";
import { viewErrorLabel, viewErrorResetKey } from "./app/view-error-policy";
import { useAppRouteSync } from "./app/use-app-route-sync";
import { initialFoundryData, useWorkspaceData } from "./app/use-workspace-data";
import { useViewScrollReset } from "./app/use-view-scroll-reset";
import { useAccountSession } from "./app/accounts-gate";
import { SidebarLanguage } from "./app/sidebar-language";
import { AccountView, withAccountNav } from "./app/account-views";
import { useTranslation } from "react-i18next";
import { Button } from "./components/ui/button";
import { Alert } from "./components/ui/alert";
import { ErrorBoundary } from "./components/ui/error-boundary";
import { IssueDetailView } from "./features/issue-detail";
import { ConnectDeviceSetup } from "./app/connect-device-setup";
import { AssetsFeature } from "./features/assets";
import {
  preferredChatId,
  useChatFeature,
  type ChatFeatureEvent,
} from "./features/chat";
import { DevicesFeature, type DeviceSection } from "./features/devices";
import {
  IssuesFeature,
  type IssueDraftRequest,
  type IssuesFeatureEvent,
} from "./features/issues";
import { ProfilesFeature } from "./features/profiles";
import { FoundrySkillPage, SkillsFeature } from "./features/skills";
import { SkillLibraryFeature } from "./features/skill-library";
import { ChannelsFeature } from "./features/channels";
import { WorkspaceConnectorsFeature } from "./features/external-accounts";
import { ConnectorsView } from "./app/connectors-view";
import { ResourcesFeature } from "./features/resources";
import { SharingFeature } from "./features/sharing";
import {
  WorkspacesFeature,
  WorkspaceHub,
  WorkspaceOverview,
  type WorkspaceSection,
  type WorkspacesFeatureEvent,
} from "./features/workspaces";
import { workspaceDenial } from "./lib/workspace-access";
import {
  issueDisplayId,
  issueSortValue,
  preferredIssueId,
} from "./lib/issue-meta";
import type { WorkerRuntimeId } from "@bd777/foundry-protocol";

export function App() {
  const account = useAccountSession();
  const { t } = useTranslation(["shell", "common"]);
  const initialRouteRef = useRef<AppRoute>(
    parseAppRoute(window.location.pathname),
  );
  const [activeView, setActiveView] = useState<NavView>(
    initialRouteRef.current.view,
  );
  const [selectedDeviceId, setSelectedDeviceId] = useState(
    initialRouteRef.current.selectedDeviceId,
  );
  const [deviceSection, setDeviceSection] = useState<DeviceSection>(
    initialRouteRef.current.deviceSection ?? "agents",
  );
  const [devicePairingMode] = useState<DevicePairingMode>(
    initialDevicePairingMode,
  );
  const [issueDraftRequest, setIssueDraftRequest] =
    useState<IssueDraftRequest>();
  const [notice, setNotice] = useState("");
  const [selectedChatId, setSelectedChatId] = useState(
    () =>
      initialRouteRef.current.selectedChatId ??
      preferredChatId(initialFoundryData().chats),
  );
  const [selectedIssueId, setSelectedIssueId] = useState(
    () =>
      initialRouteRef.current.selectedIssueId ??
      preferredIssueId(initialFoundryData().issues),
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    storedSidebarCollapsed,
  );
  const [themeMode, setThemeMode] = useState<FoundryThemeMode>(storedThemeMode);
  const issueDraftRequestIdRef = useRef(0);
  const {
    activeWorkspaceId,
    apiState,
    applyAnswered,
    data,
    demoFallback,
    loadWorkspace,
    pageFieldsLoaded,
    refreshData,
    setData,
  } = useWorkspaceData({
    activeView,
    selectedIssueId,
    setNotice,
    setSelectedChatId,
    setSelectedIssueId,
  });

  useEffect(() => {
    persistSidebarCollapsed(sidebarCollapsed);
  }, [sidebarCollapsed]);

  useEffect(() => {
    persistThemeMode(themeMode);
    document.documentElement.dataset.theme = themeMode;
  }, [themeMode]);

  // Auto-dismiss transient notices so the status line does not go stale.
  useEffect(() => {
    if (!notice) {
      return;
    }
    const timer = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  // Until a workspace is added or switched to, a workspace's views have
  // nothing to show; the Workspaces page is where to choose one.
  const needsWorkspace = apiState === "connected" && needsWorkspaceChoice(data);
  useEffect(() => {
    if (needsWorkspace && workspaceScopedViews.has(activeView))
      setActiveView("locations");
  }, [needsWorkspace, activeView]);

  async function handleWorkspaceFeatureEvent(
    event: WorkspacesFeatureEvent,
  ): Promise<boolean | void> {
    if (event.type === "workspace.browse.requested") {
      setSelectedDeviceId(undefined);
      setActiveView("locations");
      return;
    }
    if (event.type === "workspace.return.requested") {
      setActiveView("workspace");
      return;
    }
    if (event.type === "device.open.requested") {
      setSelectedDeviceId(event.deviceId);
      setDeviceSection("agents");
      setActiveView("devices");
      return;
    }
    if (event.type === "workspaces.changed") {
      // The first workspace becomes the one shown; removing the current one
      // leaves none selected until Switch: either way a whole read switches.
      const cleared = event.removedWorkspaceId === activeWorkspaceId;
      if (cleared) clearWorkspaceSelection();
      await refreshData({
        silent: true,
        throwOnError: true,
        fields:
          data.workspace.id && !cleared ? workspacesViewFields : undefined,
      });
      return;
    }
    if (event.type === "workspace.activation.requested") {
      const loaded = await loadWorkspace(event.workspaceId, event.notice);
      // The /locations chooser switches in place: on success the active
      // device+workspace changes and the Current marker updates, but the view
      // stays on /locations. On failure loadWorkspace returns false without
      // applying data, so the previous context is preserved.
      if (loaded && !event.stayOnLocation) {
        setActiveView("workspace");
      }
      return loaded;
    }
  }

  const { connectorTab, setConnectorTab } = useAppRouteSync({
    activeView,
    activeWorkspaceId,
    onPopState: (route, routeWorkspaceId) => {
      setActiveView(route.view);
      setSelectedDeviceId(route.selectedDeviceId);
      setDeviceSection(route.deviceSection ?? "agents");
      if (route.selectedChatId !== undefined) {
        setSelectedChatId(route.selectedChatId);
      } else if (route.view === "chats") {
        setSelectedChatId("");
      }
      if (route.selectedIssueId !== undefined) {
        setSelectedIssueId(route.selectedIssueId);
      }
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
    deviceSection,
  });
  useViewScrollReset(activeView, selectedIssueId);

  const sortedIssues = useMemo(() => {
    return [...data.issues].sort(
      (a, b) => issueSortValue(a) - issueSortValue(b),
    );
  }, [data.issues]);

  const selectedIssue = useMemo(() => {
    return (
      sortedIssues.find((issue) => issue.id === selectedIssueId) ??
      sortedIssues[0]
    );
  }, [sortedIssues, selectedIssueId]);

  const workspaceAssets = useMemo(
    () => currentWorkspaceAssets(data.assets, data.workspace.id),
    [data.assets, data.workspace.id],
  );

  const activeSkillCount = useMemo(
    () =>
      workspaceActiveSkillIds(
        data.workspaceSkillBindings,
        data.inheritedSkillIds,
        data.offSkillIds,
      ).size,
    [data.workspaceSkillBindings, data.inheritedSkillIds, data.offSkillIds],
  );

  const reviewCount = sortedIssues.filter(
    (issue) => issue.status === "verifying",
  ).length;
  const runningCount = sortedIssues.filter(
    (issue) => issue.status === "in_progress",
  ).length;
  const workspaceAgents = useMemo(
    () => currentWorkspaceAgents(data.agents, data.workspace),
    [data.agents, data.workspace],
  );
  const device = currentDevice(data.devices, data.workspace);
  useDocumentTitle({
    view: activeView,
    workspaceName: data.workspace.name,
    issue: selectedIssue,
    device: data.devices.find((row) => row.id === selectedDeviceId),
  });
  const workspaceFiles = useMemo(
    () => currentWorkspaceItems(data.workspaceFiles, data.workspace.id),
    [data.workspace.id, data.workspaceFiles],
  );
  const workspaceSessions = useMemo(
    () => currentWorkspaceItems(data.agentSessions, data.workspace.id),
    [data.agentSessions, data.workspace.id],
  );
  const workspaceProviderHealth = useMemo(
    () =>
      currentProviderHealth(
        data.providerHealth.filter((row) => row.deviceId === device?.id),
        workspaceAgents,
      ),
    [data.providerHealth, workspaceAgents, device?.id],
  );
  const deviceOnline =
    devicePairingMode === "online" ||
    (devicePairingMode === "auto" && device?.status === "connected");

  async function handleChatFeatureEvent(
    event: ChatFeatureEvent,
  ): Promise<void> {
    if (event.type === "chat.selected") {
      setSelectedChatId(event.chatId);
      return;
    }
    if (event.type === "notice.requested") {
      setNotice(event.message);
      return;
    }
    if (event.type === "issue.draft.requested") {
      draftFromSource(event.source);
      return;
    }
    if (event.type === "session.answered") {
      applyAnswered({
        type: "agent_session_created",
        payload: event.session,
      });
      return;
    }
    setData((current) =>
      withSessionDetails(current, event.workspaceId, event.sessions),
    );
  }

  const workspaceComposerSlashSkills = useMemo(
    () => workspaceComposerSkills(data),
    [data],
  );

  useRemovedChatSelection(data, selectedChatId, setSelectedChatId);

  const chatFeature = useChatFeature({
    active: activeView === "chats",
    agents: workspaceAgents,
    archivedChats: data.chats,
    deviceOnline,
    onEvent: handleChatFeatureEvent,
    profiles: data.agentProfiles,
    ready: apiState !== "loading",
    selectedChatId,
    sessions: workspaceSessions,
    slashSkills: workspaceComposerSlashSkills,
    workspace: data.workspace,
    workspaceId: data.workspace.id,
    workspaces: data.workspaces,
  });

  const sidebarActiveView: SidebarView =
    activeView === "issue" ? "issues" : activeView;
  const sidebarNavSections = useMemo<Array<SidebarNavSection<SidebarView>>>(
    () =>
      withAccountNav(navSections, account.user?.role).map((section) => ({
        ...section,
        label: t(`nav.${section.label as NavLabel}`),
        items: section.items.map((item) => ({
          ...item,
          label: t(`nav.${item.label as NavLabel}`),
          badge:
            item.id === "issues" && reviewCount
              ? { children: reviewCount, tone: "brass" }
              : item.id === "skills"
                ? { children: activeSkillCount, tone: "neutral" }
                : undefined,
          liveCount:
            item.id === "issues" && runningCount
              ? { children: runningCount }
              : undefined,
        })),
      })),
    [account.user?.role, reviewCount, runningCount, activeSkillCount],
  );

  function handleSidebarNavSelect(view: SidebarView): void {
    setActiveView(view);
    if (view === "devices") setSelectedDeviceId(undefined);
  }

  function openIssue(issueId: string): void {
    setSelectedIssueId(issueId);
    setActiveView("issue");
  }

  const focusComposer = useCallback(
    (source?: string, runtime?: WorkerRuntimeId): void => {
      issueDraftRequestIdRef.current += 1;
      setIssueDraftRequest({
        id: issueDraftRequestIdRef.current,
        runtime,
        source,
      });
      setActiveView("issues");
    },
    [],
  );

  const draftFromSource = useCallback(
    (source: string, runtime?: WorkerRuntimeId): void => {
      focusComposer(source, runtime);
      setNotice(t("notices.draftLoaded"));
    },
    [focusComposer],
  );

  async function handleIssuesFeatureEvent(
    event: IssuesFeatureEvent,
  ): Promise<void> {
    if (event.type === "notice.requested") {
      setNotice(event.message);
      return;
    }
    if (event.type === "issue.open.requested") {
      openIssue(event.issueId);
      return;
    }
    applyAnswered({ type: "issue_created", payload: event.issue });
    openIssue(event.issue.id);
    setNotice(
      t("notices.issueCreated", { issue: issueDisplayId(event.issue) }),
    );
  }

  function renderSetupView() {
    return (
      <ConnectDeviceSetup onOpenDevices={() => setActiveView("devices")} />
    );
  }

  function renderIssuesView() {
    return (
      <IssuesFeature
        key={data.workspace.id}
        draftRequest={issueDraftRequest}
        issues={sortedIssues}
        onEvent={handleIssuesFeatureEvent}
        selectedIssueId={selectedIssue?.id}
        workspace={data.workspace}
        providerHealth={workspaceProviderHealth}
        agents={workspaceAgents}
        profiles={data.agentProfiles}
        workerRunsIssues={
          device
            ? Boolean(device.capabilities?.includes("issue_sessions"))
            : undefined
        }
      />
    );
  }

  function renderChatsView() {
    return chatFeature;
  }

  function renderAssetsView() {
    return (
      <AssetsFeature
        embedded
        agents={workspaceAgents}
        assets={workspaceAssets}
        device={device}
        deviceOnline={deviceOnline}
        files={workspaceFiles}
        onEvent={(event) => {
          if (event.type === "data.refresh.requested") {
            void refreshData({ fields: assetsViewFields });
          } else {
            setNotice(t("notices.openDaemonLogs"));
          }
        }}
        providerHealth={workspaceProviderHealth}
        runningCount={runningCount}
        workspace={data.workspace}
      />
    );
  }

  function renderSkillsView() {
    return (
      <SkillsFeature
        bindings={data.workspaceSkillBindings}
        catalog={data.promotedSkills}
        catalogLoading={!pageFieldsLoaded.has("promotedSkills")}
        devices={data.devices}
        embedded
        onChanged={() =>
          refreshData({ silent: true, fields: skillsViewFields })
        }
        onEvent={(event) => {
          if (event.type === "notice.requested") {
            setNotice(event.message);
            return;
          }
          setSelectedDeviceId(undefined);
          setDeviceSection("skills");
          setActiveView("devices");
        }}
        workspaceId={data.workspace.id}
        workspaceDeviceId={data.workspace.deviceId}
        providerHealth={data.providerHealth.filter(
          (row) => row.deviceId === data.workspace.deviceId,
        )}
        builtinSkills={data.builtinSkills}
        defaultSkillIds={data.defaultSkillIds}
        deviceTools={data.deviceTools}
        skillBundles={data.skillBundles}
        workspaceBundleIds={data.workspaceBundleIds}
        defaultBundleIds={data.defaultBundleIds}
        inheritedSkillIds={data.inheritedSkillIds}
        offSkillIds={data.offSkillIds}
        workspaces={data.workspaces}
        readOnlyReason={workspaceDenial(data.workspace, "maintainer")}
      />
    );
  }

  function renderWorkspaceView(section: WorkspaceSection = "workspace") {
    return (
      <WorkspaceHub
        workspace={data.workspace}
        section={section}
        onSectionChange={setActiveView}
        selector={null}
      >
        {section === "workspace" ? (
          <WorkspaceOverview
            key={data.workspace.id}
            workspace={data.workspace}
            deviceOnline={deviceOnline}
            deviceLabel={device?.label}
            acceptedCount={
              sortedIssues.filter((issue) => issue.status === "accepted").length
            }
          />
        ) : null}
        {section === "settings" ? (
          device && !device.owned ? (
            <Alert title={t("settings.managedByOwner")}>
              {t("settings.managedByOwnerBody", { device: device.label })}
            </Alert>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setSelectedDeviceId(device?.id);
                setDeviceSection("agents");
                setActiveView("devices");
              }}
            >
              {t("settings.manageAgents", {
                device: device?.label ?? t("settings.thisDevice"),
              })}
            </Button>
          )
        ) : null}
        {section === "assets" ? renderAssetsView() : null}
        {section === "skills" ? renderSkillsView() : null}
        {section === "sharing" ? (
          <SharingFeature
            key={data.workspace.id}
            workspace={data.workspace}
            deviceLabel={device?.label}
            currentUserId={account.user?.id ?? ""}
            canInvite={account.user?.role === "admin"}
            onLeft={() => {
              setNotice(
                t("notices.leftWorkspace", { workspace: data.workspace.name }),
              );
              // The server ends this account's stream; it resyncs, and the
              // whole read then shows another workspace.
              setActiveView("locations");
            }}
          />
        ) : null}
        {section === "channels" ? (
          <ChannelsFeature
            key={data.workspace.id}
            readOnlyReason={workspaceDenial(data.workspace, "maintainer")}
            workspaceId={data.workspace.id}
            workspaceName={data.workspace.name}
            onNotice={setNotice}
            onOpenChats={() => setActiveView("chats")}
            onOpenConnectors={() => setActiveView("connectors")}
          />
        ) : null}
        {section === "workspaceConnectors" ? (
          <WorkspaceConnectorsFeature
            currentUserId={account.user?.id ?? ""}
            onNotice={setNotice}
            readOnlyReason={workspaceDenial(data.workspace, "maintainer")}
            workspaceId={data.workspace.id}
          />
        ) : null}
      </WorkspaceHub>
    );
  }

  function renderDevicesView() {
    return (
      <DevicesFeature
        devices={data.devices}
        selectedDeviceId={selectedDeviceId}
        section={deviceSection}
        activeWorkspaceId={activeWorkspaceId}
        workspaces={data.workspaces}
        agentProfiles={data.agentProfiles}
        deviceProfiles={data.deviceProfiles}
        deviceSkillRoots={data.deviceSkillRoots}
        onSelect={(id, section = "agents") => {
          setSelectedDeviceId(id);
          setDeviceSection(section);
        }}
        onOpenWorkspaces={(deviceId) => {
          setSelectedDeviceId(deviceId);
          setActiveView("locations");
        }}
        onOpenWorkspace={async (id) => {
          const loaded = await loadWorkspace(id);
          if (loaded) setActiveView("workspace");
          return loaded;
        }}
        onRefresh={() =>
          refreshData({
            silent: true,
            throwOnError: true,
            fields: devicesViewFields,
          })
        }
        onManageConnections={() => setActiveView("profiles")}
        profiles={data.profiles}
        providerHealth={data.providerHealth}
      />
    );
  }

  function renderProfilesView() {
    return (
      <ProfilesFeature
        devices={data.devices}
        deviceProfiles={data.deviceProfiles}
        onOpenDevices={() => {
          setSelectedDeviceId(undefined);
          setActiveView("devices");
        }}
        onEvent={async (event) => {
          if (event.type === "notice.requested") setNotice(event.message);
          else await refreshData({ fields: profilesViewFields });
        }}
        profiles={data.profiles}
      />
    );
  }

  function renderActiveView() {
    switch (activeView) {
      case "account":
      case "members":
        return (
          <AccountView
            fallback={renderWorkspaceView()}
            onNotice={setNotice}
            view={activeView}
          />
        );
      case "issues":
        if (!deviceOnline) {
          return renderSetupView();
        }
        return renderIssuesView();
      case "issue":
        return (
          <IssueDetailView
            callbacks={{
              onDraftFromSource: draftFromSource,
              onNotice: setNotice,
            }}
            deviceLabel={device?.label ?? t("notices.noDevice")}
            issue={selectedIssue}
            history={data.runs}
            onBack={() => setActiveView("issues")}
            workspaceBaseline={data.workspace.baseline}
          />
        );
      case "chats":
        return renderChatsView();
      case "assets":
      case "skills":
      case "settings":
      case "channels":
      case "workspaceConnectors":
      case "sharing":
        return renderWorkspaceView(activeView);
      case "workspace":
        return renderWorkspaceView();
      case "foundrySkill":
        return <FoundrySkillPage />;
      case "devices":
        return renderDevicesView();
      case "locations":
        return (
          <WorkspacesFeature
            activeWorkspaceId={activeWorkspaceId}
            devices={data.devices}
            focusDeviceId={selectedDeviceId}
            workspaces={data.workspaces}
            onEvent={handleWorkspaceFeatureEvent}
          />
        );
      case "profiles":
        return renderProfilesView();
      case "connectors":
        return (
          <ConnectorsView
            onNotice={setNotice}
            onTabChange={setConnectorTab}
            tab={connectorTab}
          />
        );
      case "resources":
        return (
          <ResourcesFeature
            ownedDeviceIds={data.devices
              .filter((device) => device.owned)
              .map((device) => device.id)}
          />
        );
      case "library":
        return (
          <SkillLibraryFeature
            canManage={account.user?.role === "admin"}
            catalog={data.promotedSkills}
            catalogLoading={!pageFieldsLoaded.has("promotedSkills")}
            deviceTools={data.deviceTools}
            devices={data.devices}
            onChanged={() =>
              refreshData({ silent: true, fields: libraryViewFields })
            }
          />
        );
    }
  }

  const viewScrollMode = scrollModeForView(activeView);

  return (
    <FoundryShell scrollMode={viewScrollMode} theme={themeMode}>
      <FoundrySidebar
        activeItemId={sidebarActiveView}
        collapsed={sidebarCollapsed}
        languageControl={<SidebarLanguage onError={setNotice} />}
        navSections={sidebarNavSections}
        onNavSelect={handleSidebarNavSelect}
        onThemeToggle={() =>
          setThemeMode((current) => (current === "dark" ? "light" : "dark"))
        }
        onToggleCollapsed={() => setSidebarCollapsed((collapsed) => !collapsed)}
        theme={themeMode}
        workspaceName={data.workspace.name}
        workspaceSelector={
          <WorkspacesFeature
            compact
            activeWorkspaceId={activeWorkspaceId}
            devices={data.devices}
            onEvent={handleWorkspaceFeatureEvent}
            workspaces={data.workspaces}
          />
        }
      />

      <FoundryMain>
        <NoticeStack>
          {apiState === "fallback" ? (
            <NoticeLine>
              {demoFallback
                ? t("notices.demoFallback")
                : t("notices.apiUnreachable")}
            </NoticeLine>
          ) : null}
          {apiState === "saving" ? (
            <NoticeLine>{t("common:states.saving")}</NoticeLine>
          ) : null}
          {apiState === "loading" ? (
            <NoticeLine>{t("common:states.loading")}</NoticeLine>
          ) : null}
          {notice ? <NoticeLine>{notice}</NoticeLine> : null}
          <NewBuildNotice />
        </NoticeStack>
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
            {renderActiveView()}
          </ErrorBoundary>
        </FoundryView>
      </FoundryMain>
    </FoundryShell>
  );
}
