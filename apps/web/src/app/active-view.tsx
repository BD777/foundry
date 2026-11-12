import type { ToastTone } from "../components/ui/toast";
import { ownedDeviceCandidates } from "../lib/devices";
import { useCallback, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { AgentSession } from "@bd777/foundry-protocol";
import { sessionTranscriptItems } from "../features/chat";
import type {
  AssistantSettingsSection,
  InterfaceMode,
} from "../lib/assistant-settings-sections";
import type { ConnectorType } from "../lib/connector-types";
import type { ProviderTab } from "../lib/provider-tabs";
import {
  AssistantHome,
  AssistantList,
  AssistantSettings,
  type AssistantFeatureEvent,
} from "../features/personal-agent";
import { DevicesFeature } from "../features/devices";
import { IssueDetailView } from "../features/issue-detail";
import {
  IssuesFeature,
  type IssueDraftRequest,
  type IssuesFeatureEvent,
} from "../features/issues";
import { PendingFeature, type PendingItems } from "../features/pending";
import { ProfilesFeature } from "../features/profiles";
import { ResourcesFeature } from "../features/resources";
import { SkillLibraryFeature } from "../features/skill-library";
import { FoundrySkillPage } from "../features/skills";
import { UsageFeature } from "../features/usage";
import {
  WorkspacesFeature,
  type WorkspacesFeatureEvent,
} from "../features/workspaces";
import { issueDisplayId } from "../lib/issue-meta";
import { AccountView } from "./account-views";
import { useAccountSession } from "./accounts-gate";
import { ConnectDeviceSetup } from "./connect-device-setup";
import { ConnectorsView } from "./connectors-view";
import type { AppLocation } from "./use-app-location";
import { useLinkedIssue } from "./use-linked-issue";
import type { CurrentWorkspace } from "./use-current-workspace";
import type { useIssueDraftRequest } from "./use-issue-draft-request";
import type { WorkspaceData } from "./use-workspace-data";
import {
  devicesViewFields,
  libraryViewFields,
  profilesViewFields,
} from "./view-fields";
import { WorkspaceHubView } from "./workspace-hub-view";
import type { AssistantDirectory } from "./use-assistants";

/** What the shell hands every page it renders. */
export interface AppViewContext {
  current: CurrentWorkspace;
  location: AppLocation;
  setNotice: (message: string, tone?: ToastTone) => void;
  workspaceData: WorkspaceData;
}

export interface ActiveViewProps extends AppViewContext {
  assistantSection?: AssistantSettingsSection;
  assistants: AssistantDirectory;
  onAssistantsReload: () => Promise<void>;
  onAssistantSectionChange: (section: AssistantSettingsSection) => void;
  /** The assistant saved a new interface (its simpleInterface setting). */
  onInterfaceModeChange: (mode: InterfaceMode) => void;
  /** The Chats page, kept by the shell so chats live across pages. */
  chatView: ReactNode;
  connectorTab: ConnectorType;
  issueDraft: ReturnType<typeof useIssueDraftRequest>;
  onConnectorTabChange: (tab: ConnectorType) => void;
  onProviderTabChange: (tab: ProviderTab) => void;
  providerTab: ProviderTab;
  onWorkspaceEvent: (event: WorkspacesFeatureEvent) => Promise<boolean | void>;
  /** The person's pending items, read once for the whole shell. */
  pending: PendingItems;
}

/** The page the route shows, wired to the shell's data and navigation. */
export function ActiveView({
  assistantSection,
  assistants,
  onAssistantsReload,
  onAssistantSectionChange,
  onInterfaceModeChange,
  chatView,
  connectorTab,
  issueDraft,
  onConnectorTabChange,
  onProviderTabChange,
  providerTab,
  onWorkspaceEvent,
  pending,
  ...context
}: ActiveViewProps) {
  const { current, location, setNotice, workspaceData } = context;
  const { activeWorkspaceId, data, pageFieldsLoaded, refreshData } =
    workspaceData;
  const { activeView, selectedDeviceId } = location;
  const account = useAccountSession();

  async function handleAssistantEvent(
    event: AssistantFeatureEvent,
  ): Promise<void> {
    switch (event.type) {
      case "notice.requested":
        setNotice(event.message, event.tone);
        return;
      case "settings.open":
        if (event.section) onAssistantSectionChange(event.section);
        location.setActiveView("assistantSettings");
        return;
      case "assistants.open":
        location.setActiveView("assistants");
        return;
      case "assistant.open":
        location.setSelectedAssistantId(event.assistantId);
        location.setActiveView("assistant");
        return;
      case "assistant.created":
        await onAssistantsReload();
        location.setSelectedAssistantId(event.assistantId);
        onAssistantSectionChange("places");
        location.setActiveView("assistantSettings");
        return;
      case "assistants.changed":
        void onAssistantsReload();
        return;
      case "home.open":
        location.setActiveView("assistant");
        return;
      case "pending.open":
        location.setActiveView("pending");
        return;
      case "devices.open":
        location.openDevices(
          event.deviceId,
          event.deviceId ? "settings" : undefined,
        );
        return;
      case "interface.changed":
        onInterfaceModeChange(event.mode);
        return;
    }
  }

  switch (activeView) {
    case "assistants":
      return (
        <AssistantList
          assistants={assistants.assistants}
          devices={data.devices}
          error={assistants.state === "failed" ? assistants.message : undefined}
          onEvent={handleAssistantEvent}
          onReload={onAssistantsReload}
          selectedAssistantId={location.selectedAssistantId}
          state={assistants.state}
        />
      );
    case "assistant":
      if (!location.selectedAssistantId) {
        return (
          <AssistantList
            assistants={assistants.assistants}
            devices={data.devices}
            error={
              assistants.state === "failed" ? assistants.message : undefined
            }
            onEvent={handleAssistantEvent}
            onReload={onAssistantsReload}
            selectedAssistantId={location.selectedAssistantId}
            state={assistants.state}
          />
        );
      }
      return (
        <AssistantHome
          assistantId={location.selectedAssistantId}
          agentProfiles={data.agentProfiles}
          assistants={assistants.assistants}
          devices={data.devices}
          key={location.selectedAssistantId}
          onEvent={handleAssistantEvent}
          workspaces={data.workspaces}
        />
      );
    case "assistantSettings":
      if (!location.selectedAssistantId) {
        return (
          <AssistantList
            assistants={assistants.assistants}
            devices={data.devices}
            error={
              assistants.state === "failed" ? assistants.message : undefined
            }
            onEvent={handleAssistantEvent}
            onReload={onAssistantsReload}
            selectedAssistantId={location.selectedAssistantId}
            state={assistants.state}
          />
        );
      }
      return (
        <AssistantSettings
          agentProfiles={data.agentProfiles}
          assistantId={location.selectedAssistantId}
          assistants={assistants.assistants}
          devices={data.devices}
          key={location.selectedAssistantId}
          onEvent={handleAssistantEvent}
          onSectionChange={onAssistantSectionChange}
          profiles={data.profiles}
          section={assistantSection}
          workspaces={data.workspaces}
        />
      );
    case "account":
    case "members":
      return (
        <AccountView
          fallback={<WorkspaceHubView {...context} />}
          onNotice={setNotice}
          view={activeView}
        />
      );
    case "issues":
      if (!current.deviceOnline) {
        return (
          <ConnectDeviceSetup
            onOpenDevices={() => location.setActiveView("devices")}
          />
        );
      }
      return <IssuesView {...context} draftRequest={issueDraft.request} />;
    case "issue":
      return <LinkedIssueView {...context} issueDraft={issueDraft} />;
    case "chats":
      return chatView;
    case "assets":
    case "skills":
    case "settings":
    case "channels":
    case "workspaceConnectors":
    case "sharing":
      return <WorkspaceHubView {...context} section={activeView} />;
    case "workspace":
      return <WorkspaceHubView {...context} />;
    case "foundrySkill":
      return <FoundrySkillPage />;
    case "devices":
      return <DevicesView {...context} />;
    case "locations":
      return (
        <WorkspacesFeature
          activeWorkspaceId={activeWorkspaceId}
          devices={data.devices}
          focusDeviceId={
            // /locations/<workspace>: the group of the device it is on.
            data.workspaces.find((row) => row.id === selectedDeviceId)
              ?.deviceId ?? selectedDeviceId
          }
          workspaces={data.workspaces}
          onEvent={onWorkspaceEvent}
        />
      );
    case "profiles":
      return (
        <ProfilesFeature
          agentProfiles={data.agentProfiles}
          devices={data.devices}
          deviceProfiles={data.deviceProfiles}
          providerHealth={data.providerHealth}
          onEvent={async (event) => {
            if (event.type === "notice.requested")
              setNotice(event.message, event.tone);
            else await refreshData({ fields: profilesViewFields });
          }}
          profiles={data.profiles}
          tab={providerTab}
          onTabChange={onProviderTabChange}
        />
      );
    case "pending":
      return <PendingFeature pending={pending} />;
    case "connectors":
      return (
        <ConnectorsView
          onNotice={setNotice}
          onTabChange={onConnectorTabChange}
          tab={connectorTab}
        />
      );
    case "resources":
      return (
        <ResourcesFeature
          ownedDeviceIds={ownedDeviceCandidates(data.devices).map(
            (device) => device.id,
          )}
        />
      );
    case "usage":
      return (
        <UsageFeature
          currentUser={account.user}
          devices={data.devices}
          isAdmin={account.user?.role === "admin"}
          workspaces={data.workspaces}
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

/**
 * The Issue the route names; one another workspace holds opens there
 * (useLinkedIssue), never another Issue in its place.
 */
function LinkedIssueView({
  current,
  issueDraft,
  location,
  setNotice,
  workspaceData,
}: AppViewContext & Pick<ActiveViewProps, "issueDraft">) {
  const { t } = useTranslation("shell");
  const { apiState, data } = workspaceData;
  const linked = useLinkedIssue({
    issueId: location.selectedIssueId,
    issues: data.issues,
    ready: apiState !== "loading",
    workspaceId: data.workspace.id,
  });
  // An Issue's executions are sessions: its conversation shows them as a
  // chat shows sessions.
  const devices = data.devices;
  const executionTranscript = useCallback(
    (executions: AgentSession[]) => sessionTranscriptItems(executions, devices),
    [devices],
  );
  return (
    <IssueDetailView
      callbacks={{
        onDraftFromSource: issueDraft.draftFromSource,
        onNotice: setNotice,
      }}
      executionTranscript={executionTranscript}
      deviceLabel={current.device?.label ?? t("notices.noDevice")}
      issue={linked === "listed" ? current.selectedIssue : undefined}
      opening={linked === "opening"}
      onBack={() => location.setActiveView("issues")}
      workspaceBaseline={data.workspace.baseline}
    />
  );
}

function DevicesView({ location, workspaceData }: AppViewContext) {
  const { activeWorkspaceId, data, refreshData } = workspaceData;
  return (
    <DevicesFeature
      devices={data.devices}
      selectedDeviceId={location.selectedDeviceId}
      section={location.deviceSection}
      activeWorkspaceId={activeWorkspaceId}
      workspaces={data.workspaces}
      agentProfiles={data.agentProfiles}
      deviceProfiles={data.deviceProfiles}
      deviceSkillRoots={data.deviceSkillRoots}
      onSelect={(id, section = "agents") => {
        location.setSelectedDeviceId(id);
        location.setDeviceSection(section);
      }}
      onOpenWorkspaces={(deviceId) => {
        location.setSelectedDeviceId(deviceId);
        location.setActiveView("locations");
      }}
      onOpenWorkspace={async (id) => {
        const loaded = await workspaceData.loadWorkspace(id);
        if (loaded) location.setActiveView("workspace");
        return loaded;
      }}
      onRefresh={() =>
        refreshData({
          silent: true,
          throwOnError: true,
          fields: devicesViewFields,
        })
      }
      onManageConnections={() => location.setActiveView("profiles")}
      profiles={data.profiles}
      providerHealth={data.providerHealth}
    />
  );
}

function IssuesView({
  current,
  draftRequest,
  location,
  setNotice,
  workspaceData: { applyAnswered, data },
}: AppViewContext & { draftRequest: IssueDraftRequest | undefined }) {
  const { t } = useTranslation("shell");

  async function handleIssuesFeatureEvent(
    event: IssuesFeatureEvent,
  ): Promise<void> {
    if (event.type === "notice.requested") {
      setNotice(event.message, event.tone);
      return;
    }
    if (event.type === "issue.open.requested") {
      location.openIssue(event.issueId);
      return;
    }
    applyAnswered({ type: "issue_created", payload: event.issue });
    location.openIssue(event.issue.id);
    setNotice(
      t("notices.issueCreated", { issue: issueDisplayId(event.issue) }),
    );
  }

  return (
    <IssuesFeature
      key={data.workspace.id}
      draftRequest={draftRequest}
      issues={current.sortedIssues}
      onEvent={handleIssuesFeatureEvent}
      selectedIssueId={current.selectedIssue?.id}
      workspace={data.workspace}
      providerHealth={current.providerHealth}
      agents={current.agents}
      profiles={data.agentProfiles}
    />
  );
}
