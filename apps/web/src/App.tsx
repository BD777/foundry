import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  BookOpen,
  CheckCircle2,
  Code2,
  Columns2,
  File as FileIcon,
  FileText,
  FolderOpen,
  Gauge,
  GitBranch,
  Hammer,
  KeyRound,
  MessageSquareText,
  Monitor,
  Terminal,
  Zap,
} from "lucide-react";
import {
  acceptIssue,
  clearProfileCredential,
  createProfile,
  deleteProfile,
  emptyWorkspace,
  isAbortError,
  loadFoundryData,
  loadFoundryWorkspace,
  listAgentModels,
  readWorkspaceFile,
  requestChanges,
  setDeviceProfiles,
  updateProfile,
} from "./api";
import type { FoundryData } from "./api-types";
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
  initialWorkspaceId,
  parseAppRoute,
  persistSidebarCollapsed,
  persistThemeMode,
  persistWorkspaceId,
  storedSidebarCollapsed,
  storedThemeMode,
  workspaceIdFromLocation,
  type AppRoute,
  type DevicePairingMode,
  type NavView,
  type SidebarView,
} from "./app/navigation";
import { mergeLoadedFoundryData } from "./app/foundry-data-projection";
import {
  firstLoadedChatId,
  resolveLoadedChatSelection,
  type LoadedChatSelection,
} from "./app/chat-selection";
import {
  currentDevice,
  currentProviderHealth,
  currentWorkspaceAgents,
  currentWorkspaceAssets,
  currentWorkspaceItems,
  currentWorkspaceSkills,
  uniqueSkills,
} from "./app/workspace-selectors";
import { viewErrorLabel, viewErrorResetKey } from "./app/view-error-policy";
import { useAppRouteSync } from "./app/use-app-route-sync";
import { useRequestChannels } from "./app/use-request-channels";
import { useFoundryLiveData } from "./app/use-foundry-live-data";
import { useViewScrollReset } from "./app/use-view-scroll-reset";
import { useAccountSession } from "./app/accounts-gate";
import { AccountView, withAccountNav } from "./app/account-views";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Alert } from "./components/ui/alert";
import { EmptyState } from "./components/ui/empty-state";
import { ErrorBoundary } from "./components/ui/error-boundary";
import { IconBox } from "./components/ui/icon-box";
import { IssueDetailView } from "./features/issue-detail";
import {
  MetaPill,
  MetaPillCaption,
  MetaPillDot,
} from "./components/ui/meta-pill";
import { RuntimeMark, runtimeMeta } from "./components/ui/runtime-mark";
import { SetupFlow } from "./components/ui/setup-flow";
import { Tooltip } from "./components/ui/tooltip";
import { AssetsFeature } from "./features/assets";
import {
  chatThreadsFromSessions,
  isChatSession,
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
import {
  ProfilesFeature,
  type ProfilesFeatureEvent,
  type ProfilesFeatureResult,
} from "./features/profiles";
import { SkillsFeature } from "./features/skills";
import { FeishuBotFeature } from "./features/feishu";
import { SharingFeature } from "./features/sharing";
import {
  WorkspacesFeature,
  WorkspaceHub,
  WorkspaceOverview,
  type WorkspaceSection,
  type WorkspacesFeatureEvent,
} from "./features/workspaces";
import { mergeLoadedAgentSession } from "./lib/agent-session-events";
import { workspaceDenial } from "./lib/workspace-access";
import {
  issueDisplayId,
  issueSortValue,
  preferredIssueId,
} from "./lib/issue-meta";
import {
  fixtureAssets,
  fixtureChats,
  fixtureDevice,
  fixtureIssues,
  fixtureProviderHealth,
  fixtureWorkspace,
  type AgentProjection,
  type AssetProjection,
  type DeviceProjection,
  type Issue,
  type IssueReadiness,
  type ProfileAuthorization,
  type ProviderHealth,
  type SkillPackRef,
  type WorkerRuntimeId,
  type WorkspaceFileEntry,
  type WorkspaceFileRead,
  type WorkspaceProjection,
} from "@foundry/protocol";

type BadgeTone = "neutral" | "online" | "brass" | "warn" | "slate" | "error";

const navSections: Array<SidebarNavSection<SidebarView>> = [
  {
    label: "Workspace",
    items: [
      { id: "workspace", label: "Overview", icon: FolderOpen },
      { id: "chats", label: "Chats", icon: MessageSquareText },
    ],
  },
  {
    label: "Manage",
    items: [
      { id: "devices", label: "Devices", icon: Monitor },
      { id: "profiles", label: "Server connections", icon: KeyRound },
    ],
  },
];

// Project a freshly-loaded payload into the chat identities the selection
// policy needs. Thread grouping stays owned by the chat feature.
function loadedChatSelection(loaded: FoundryData): LoadedChatSelection {
  const chatSessions = loaded.agentSessions.filter(isChatSession);
  return {
    chatSessions,
    chatThreads: chatThreadsFromSessions(chatSessions),
    chats: loaded.chats,
    preferredChatId: preferredChatId(loaded.chats),
  };
}

// Resolve which chat should stay selected after a data load. Shared by
// refreshData and the workspace deletion handler. The route check stays here
// because it reads live browser location.
function resolveChatSelection(
  loaded: FoundryData,
  current: string,
  options: { respectChatRoute?: boolean } = {},
): string {
  if (options.respectChatRoute) {
    const chatRoute = parseAppRoute(window.location.pathname);
    if (chatRoute.view === "chats" && !chatRoute.selectedChatId) {
      return "";
    }
  }
  return resolveLoadedChatSelection(loadedChatSelection(loaded), current);
}

// Apply a freshly-loaded FoundryData payload: merge it into state, update
// the active workspace id, and mark the API as connected. Shared by
// refreshData, loadWorkspace, and the workspace deletion handler.
function applyLoadedData(
  setData: React.Dispatch<React.SetStateAction<FoundryData>>,
  setActiveWorkspaceId: (id: string) => void,
  setApiState: (state: "connected" | "fallback" | "loading" | "saving") => void,
  loaded: FoundryData,
): void {
  setData((current) => mergeLoadedFoundryData(current, loaded));
  setActiveWorkspaceId(loaded.workspace.id);
  persistWorkspaceId(loaded.workspace.id);
  setApiState("connected");
}

export function App() {
  const account = useAccountSession();
  const initialRouteRef = useRef<AppRoute>(
    parseAppRoute(window.location.pathname),
  );
  const demoFallbackEnabled =
    import.meta.env.VITE_DEMO_FALLBACK === "1" ||
    new URLSearchParams(window.location.search).get("demo") === "1";
  const fallbackData: FoundryData = {
    workspace: fixtureWorkspace,
    workspaces: [fixtureWorkspace],
    devices: [fixtureDevice],
    providerHealth: fixtureProviderHealth,
    agentProfiles: [],
    deviceProfiles: [],
    deviceSkillRoots: [],
    deviceSkills: [],
    promotedSkills: [],
    workspaceSkillBindings: [],
    profiles: [],
    agents: [],
    workspaceFiles: [],
    agentSessions: [],
    skills: [],
    issues: fixtureIssues,
    chats: fixtureChats,
    assets: fixtureAssets,
  };
  const emptyData: FoundryData = {
    workspace: emptyWorkspace,
    workspaces: [],
    devices: [],
    providerHealth: [],
    agentProfiles: [],
    deviceProfiles: [],
    deviceSkillRoots: [],
    deviceSkills: [],
    promotedSkills: [],
    workspaceSkillBindings: [],
    profiles: [],
    agents: [],
    workspaceFiles: [],
    agentSessions: [],
    skills: [],
    issues: [],
    chats: [],
    assets: [],
  };
  const [activeView, setActiveView] = useState<NavView>(
    initialRouteRef.current.view,
  );
  const [selectedDeviceId, setSelectedDeviceId] = useState(
    initialRouteRef.current.selectedDeviceId,
  );
  const [deviceSection, setDeviceSection] = useState<DeviceSection>(
    initialRouteRef.current.deviceSection ?? "workspaces",
  );
  const [apiState, setApiState] = useState<
    "connected" | "fallback" | "loading" | "saving"
  >("loading");
  const [data, setData] = useState<FoundryData>(
    demoFallbackEnabled ? fallbackData : emptyData,
  );
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(
    initialWorkspaceId(
      (demoFallbackEnabled ? fallbackData : emptyData).workspace.id,
    ),
  );
  const [devicePairingMode, setDevicePairingMode] = useState<DevicePairingMode>(
    initialDevicePairingMode,
  );
  const [issueDraftRequest, setIssueDraftRequest] =
    useState<IssueDraftRequest>();
  const [notice, setNotice] = useState("");
  const [selectedChatId, setSelectedChatId] = useState(
    initialRouteRef.current.selectedChatId ??
      preferredChatId((demoFallbackEnabled ? fallbackData : emptyData).chats),
  );
  const [selectedIssueId, setSelectedIssueId] = useState(
    initialRouteRef.current.selectedIssueId ??
      preferredIssueId((demoFallbackEnabled ? fallbackData : emptyData).issues),
  );
  const [selectedFileRead, setSelectedFileRead] = useState<WorkspaceFileRead>();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    storedSidebarCollapsed,
  );
  const [themeMode, setThemeMode] = useState<FoundryThemeMode>(storedThemeMode);
  const issueDraftRequestIdRef = useRef(0);
  const workspaceLoadSeqRef = useRef(0);
  const workspaceLoadingRef = useRef(false);
  const requestChannels = useRequestChannels();

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

  async function refreshData(
    nextSelectedIssueId?: string,
    options: { silent?: boolean; throwOnError?: boolean } = {},
  ): Promise<void> {
    if (workspaceLoadingRef.current) return;
    const workspaceSeq = workspaceLoadSeqRef.current;
    try {
      const result = await loadFoundryData(activeWorkspaceId);
      if (workspaceSeq !== workspaceLoadSeqRef.current) return;
      if (result.notModified) {
        applyLoadedData(
          setData,
          setActiveWorkspaceId,
          setApiState,
          result.data,
        );
        setApiState("connected");
        if (!options.silent) {
          setNotice("Data refreshed.");
        }
        return;
      }
      const loaded = result.data;
      applyLoadedData(setData, setActiveWorkspaceId, setApiState, loaded);
      setSelectedIssueId((current) => {
        if (
          nextSelectedIssueId &&
          loaded.issues.some((issue) => issue.id === nextSelectedIssueId)
        ) {
          return nextSelectedIssueId;
        }
        return loaded.issues.some((issue) => issue.id === current)
          ? current
          : preferredIssueId(loaded.issues);
      });
      setSelectedChatId((current) =>
        resolveChatSelection(loaded, current, { respectChatRoute: true }),
      );
      setApiState("connected");
      if (!options.silent) {
        setNotice("Data refreshed.");
      }
    } catch {
      if (workspaceSeq !== workspaceLoadSeqRef.current) return;
      // A transient reconnect must not erase the task or unmount its draft.
      setData((current) =>
        current.workspace.id
          ? current
          : demoFallbackEnabled
            ? fallbackData
            : emptyData,
      );
      setApiState("fallback");
      if (options.throwOnError) throw new Error("Local API is not reachable.");
      if (!options.silent) {
        setNotice(
          demoFallbackEnabled
            ? "Using fixture data because the local API is not reachable."
            : "Local API is not reachable.",
        );
      }
    }
  }

  async function loadWorkspace(
    workspaceId: string,
    noticeMessage?: string,
    options: { selectedChatId?: string } = {},
  ): Promise<boolean> {
    if (!workspaceId || workspaceId === data.workspace.id) {
      return workspaceId === data.workspace.id;
    }
    const requestSeq = workspaceLoadSeqRef.current + 1;
    workspaceLoadSeqRef.current = requestSeq;
    workspaceLoadingRef.current = true;
    const signal = requestChannels.signalFor("workspace-load");
    try {
      setApiState("loading");
      const loaded = (await loadFoundryWorkspace(workspaceId, { signal })).data;
      // The sequence guard still protects state that a resolved-but-stale
      // response could clobber before its abort is observed.
      if (workspaceLoadSeqRef.current !== requestSeq) {
        return false;
      }
      if (loaded.workspace.id !== workspaceId) {
        throw new Error("The requested workspace is no longer available.");
      }
      applyLoadedData(setData, setActiveWorkspaceId, setApiState, loaded);
      requestChannels.abort("file-read");
      setSelectedFileRead(undefined);
      setSelectedChatId(
        options.selectedChatId ??
          firstLoadedChatId(loadedChatSelection(loaded)),
      );
      setApiState("connected");
      if (noticeMessage) {
        setNotice(noticeMessage);
      }
      return true;
    } catch (error) {
      if (isAbortError(error) || workspaceLoadSeqRef.current !== requestSeq) {
        return false;
      }
      setApiState("fallback");
      setNotice(
        "Could not switch workspace because the local API is not reachable.",
      );
      return false;
    } finally {
      if (workspaceLoadSeqRef.current === requestSeq) {
        workspaceLoadingRef.current = false;
      }
    }
  }

  async function handleWorkspaceFeatureEvent(
    event: WorkspacesFeatureEvent,
  ): Promise<boolean | void> {
    if (event.type === "workspace.browse.requested") {
      setActiveView("locations");
      return;
    }
    if (event.type === "workspace.return.requested") {
      setActiveView("workspace");
      return;
    }
    if (event.type === "workspace.management.requested") {
      setSelectedDeviceId(event.deviceId);
      setDeviceSection("workspaces");
      setActiveView("devices");
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

  useEffect(() => {
    const routeWorkspaceId = workspaceIdFromLocation();
    if (routeWorkspaceId) {
      persistWorkspaceId(routeWorkspaceId);
    }
    void refreshData(selectedIssueId, { silent: true });
  }, []);

  const hasActiveAgentSession = data.agentSessions.some(
    (session) => session.status === "queued" || session.status === "running",
  );

  useFoundryLiveData({
    activeSession:
      hasActiveAgentSession ||
      data.issues.some((issue) => issue.status === "in_progress"),
    enabled: !demoFallbackEnabled,
    onRefresh: () => refreshData(undefined, { silent: true }),
    setData,
    workspaceId: activeWorkspaceId,
  });
  useAppRouteSync({
    activeView,
    activeWorkspaceId,
    onPopState: (route, routeWorkspaceId) => {
      setActiveView(route.view);
      setSelectedDeviceId(route.selectedDeviceId);
      setDeviceSection(route.deviceSection ?? "workspaces");
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

  const issueSkills = useMemo(() => uniqueSkills(sortedIssues), [sortedIssues]);
  const workspaceSkills = useMemo(
    () => currentWorkspaceSkills(data.skills, data.workspace.id),
    [data.skills, data.workspace.id],
  );
  const skills = useMemo(
    () => (workspaceSkills.length > 0 ? workspaceSkills : issueSkills),
    [issueSkills, workspaceSkills],
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
    if (event.type === "data.refresh.requested") {
      await refreshData(undefined, { silent: true });
      return;
    }
    setData((current) => {
      if (current.workspace.id !== event.workspaceId) {
        return current;
      }
      const loadedById = new Map(
        event.sessions
          .filter((session) => session.workspaceId === event.workspaceId)
          .map((session) => [session.id, session]),
      );
      if (loadedById.size === 0) {
        return current;
      }
      return {
        ...current,
        agentSessions: current.agentSessions.map((session) => {
          const loaded = loadedById.get(session.id);
          return loaded ? mergeLoadedAgentSession(session, loaded) : session;
        }),
      };
    });
  }

  const workspaceSlashSkills = useMemo(() => {
    const selected = new Set(
      data.workspaceSkillBindings.map((binding) => binding.skillId),
    );
    return data.promotedSkills
      .filter((skill) => selected.has(skill.id))
      .map((skill) => ({
        value: skill.name,
        label: skill.name,
        description: skill.description,
      }));
  }, [data.promotedSkills, data.workspaceSkillBindings]);

  const chatFeature = useChatFeature({
    active: activeView === "chats",
    agents: workspaceAgents,
    archivedChats: data.chats,
    deviceOnline,
    onEvent: handleChatFeatureEvent,
    profiles: data.agentProfiles,
    selectedChatId,
    sessions: workspaceSessions,
    slashSkills: workspaceSlashSkills,
    workspace: data.workspace,
    workspaceId: data.workspace.id,
  });

  const sidebarActiveView: SidebarView =
    activeView === "issue" ? "issues" : activeView;
  const sidebarNavSections = useMemo<Array<SidebarNavSection<SidebarView>>>(
    () =>
      withAccountNav(navSections, account.user?.role).map((section) => ({
        ...section,
        items: section.items.map((item) => ({
          ...item,
          badge:
            item.id === "issues" && reviewCount
              ? { children: reviewCount, tone: "brass" }
              : item.id === "skills"
                ? { children: skills.length, tone: "neutral" }
                : undefined,
          liveCount:
            item.id === "issues" && runningCount
              ? { children: runningCount }
              : undefined,
        })),
      })),
    [account.user?.role, reviewCount, runningCount, skills.length],
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
      setNotice("Draft loaded into the issue composer.");
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
    setSelectedIssueId(event.issue.id);
    await refreshData(event.issue.id);
    openIssue(event.issue.id);
    setNotice(
      `${issueDisplayId(event.issue)} created · awaiting contract confirmation.`,
    );
  }

  async function handleAcceptIssue(): Promise<void> {
    if (!selectedIssue) {
      setNotice("Select an issue first.");
      return;
    }
    if (selectedIssue.status !== "verifying") {
      setNotice(
        `${issueDisplayId(selectedIssue)} is ${selectedIssue.status}; only review issues can be accepted.`,
      );
      return;
    }
    try {
      setApiState("saving");
      const issue = await acceptIssue(
        selectedIssue.id,
        selectedIssue.run?.environmentRevision,
      );
      await refreshData(issue.id);
      setNotice(`${issueDisplayId(issue)} accepted.`);
    } catch (error) {
      // A rejected Accept (for example, a merge conflict) is not an outage.
      // Re-read the authoritative state, including any partial recovery state.
      await refreshData(selectedIssue.id, { silent: true });
      setNotice(
        `Workspace Accept did not complete: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function handleRequestChanges(): Promise<void> {
    if (!selectedIssue) {
      setNotice("Select an issue first.");
      return;
    }
    if (selectedIssue.status !== "verifying") {
      setNotice(
        `${issueDisplayId(selectedIssue)} is ${selectedIssue.status}; request changes when it is in review.`,
      );
      return;
    }
    try {
      setApiState("saving");
      const issue = await requestChanges(selectedIssue.id);
      await refreshData(issue.id);
      setNotice(`${issueDisplayId(issue)} returned to ready.`);
    } catch (error) {
      await refreshData(selectedIssue.id, { silent: true });
      setNotice(
        `Could not request changes: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function handleReadWorkspacePath(path: string): Promise<void> {
    if (!data.workspace.id) {
      setNotice("Connect a local workspace first.");
      return;
    }
    try {
      const content = await readWorkspaceFile(
        { workspaceId: data.workspace.id, path },
        { signal: requestChannels.signalFor("file-read") },
      );
      setSelectedFileRead(content);
      setNotice(`${path} loaded from the local daemon.`);
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      setNotice(`Could not read ${path} through the local daemon.`);
    }
  }

  async function handleReadWorkspaceFile(
    file: WorkspaceFileEntry,
  ): Promise<void> {
    await handleReadWorkspacePath(file.path);
  }

  async function handleProfilesFeatureEvent(
    event: ProfilesFeatureEvent,
  ): Promise<ProfilesFeatureResult> {
    try {
      if (event.type === "load-models") {
        return await listAgentModels(event.profile);
      }
      if (event.type === "set-device-profiles") {
        await setDeviceProfiles({
          deviceId: event.deviceId,
          profileIds: event.profileIds,
        });
        await refreshData();
        return;
      }
      if (event.type === "save-profile") {
        const profile = event.input.id
          ? await updateProfile(event.input.id, event.input)
          : await createProfile(event.input);
        await refreshData();
        setNotice(`${profile.label} saved.`);
        return profile;
      }
      if (event.type === "delete-profile") {
        const profile = await deleteProfile(event.profileId);
        await refreshData();
        setNotice(`${profile.label} deleted.`);
        return profile;
      }
      const profile = await clearProfileCredential(event.profileId);
      await refreshData();
      setNotice(`Credential cleared for ${profile.label}.`);
      return profile;
    } catch (error) {
      setNotice("Could not save this change to the server.");
      throw error;
    }
  }

  function workerCommandNotice(): void {
    setNotice(
      `Run npx @foundry/agent device connect for ${data.workspace.localPath.replace("/Users/you/", "~/")}.`,
    );
  }

  function followUpFromIssue(issue: Issue): void {
    draftFromSource(
      `Follow up on ${issueDisplayId(issue)}: ${issue.title}\n\n${issue.sourceInput}`,
      issue.runtime,
    );
  }

  function renderSetupView() {
    return (
      <SetupFlow
        actionLabel="Simulate device online"
        body={
          <>
            Foundry runs workers on <em>your</em> machine. Pair a device and it
            owns filesystem and runtime access — the server only coordinates and
            never sees your credentials.
          </>
        }
        kicker="No device connected"
        onAction={() => {
          setDevicePairingMode("online");
          setNotice("Device marked online for this workspace.");
        }}
        status="Waiting for pairing… the device appears here automatically."
        steps={[
          {
            commands: [
              <>
                npx @foundry/agent init{" "}
                {data.workspace.localPath.replace("/Users/you/", "~/")}
              </>,
              "npx @foundry/agent device connect",
            ],
            hint: "runs via npx, no global install",
            number: "1",
            state: "primary",
            title: "Install & pair the device",
          },
          {
            hint: "Claude · Codex",
            number: "2",
            title: "Install worker runtimes locally",
          },
          {
            hint: "secrets stay on this machine",
            number: "3",
            title: "Submit your first issue",
          },
        ]}
        title="Connect a device"
      />
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
            void refreshData();
          } else {
            setNotice("Open the local daemon logs from the paired device.");
          }
        }}
        providerHealth={workspaceProviderHealth}
        runningCount={runningCount}
        skillCount={skills.length}
        workspace={data.workspace}
      />
    );
  }

  function renderSkillsView() {
    return (
      <SkillsFeature
        bindings={data.workspaceSkillBindings}
        catalog={data.promotedSkills}
        devices={data.devices}
        deviceSkills={data.deviceSkills}
        embedded
        onChanged={() => refreshData(undefined, { silent: true })}
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
            <Alert title="Managed by the device owner">
              Agents and execution on {device.label} are managed by the account
              that paired it. This workspace is shared with you.
            </Alert>
          ) : (
            <Button
              variant="secondary"
              onClick={() => {
                setSelectedDeviceId(device?.id);
                setDeviceSection("agents");
                setActiveView("devices");
              }}
            >
              Manage agents and execution on {device?.label ?? "this device"} →
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
              setNotice(`You left ${data.workspace.name}.`);
              setActiveView("locations");
              void refreshData(undefined, { silent: true });
            }}
          />
        ) : null}
        {section === "feishu" ? (
          <FeishuBotFeature
            key={data.workspace.id}
            readOnlyReason={workspaceDenial(data.workspace, "maintainer")}
            workspaceId={data.workspace.id}
            workspaceName={data.workspace.name}
            onNotice={setNotice}
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
        deviceSkills={data.deviceSkills}
        onSelect={(id, section = "workspaces") => {
          setSelectedDeviceId(id);
          setDeviceSection(section);
        }}
        onOpenWorkspace={async (id) => {
          const loaded = await loadWorkspace(id);
          if (loaded) setActiveView("workspace");
          return loaded;
        }}
        onRefresh={() =>
          refreshData(undefined, { silent: true, throwOnError: true })
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
        onEvent={handleProfilesFeatureEvent}
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
      case "issue":
        return renderWorkspaceView();
      case "chats":
        return renderChatsView();
      case "assets":
      case "skills":
      case "settings":
      case "feishu":
      case "sharing":
        return renderWorkspaceView(activeView);
      case "workspace":
        return renderWorkspaceView();
      case "devices":
        return renderDevicesView();
      case "locations":
        return (
          <WorkspacesFeature
            activeWorkspaceId={activeWorkspaceId}
            devices={data.devices}
            workspaces={data.workspaces}
            onEvent={handleWorkspaceFeatureEvent}
          />
        );
      case "profiles":
        return renderProfilesView();
    }
  }

  const viewScrollMode: "page" | "contained" =
    activeView === "account" ||
    activeView === "members" ||
    activeView === "assets" ||
    activeView === "skills" ||
    activeView === "settings" ||
    activeView === "feishu" ||
    activeView === "sharing" ||
    activeView === "workspace" ||
    activeView === "devices" ||
    activeView === "locations" ||
    activeView === "profiles"
      ? "page"
      : "contained";

  return (
    <FoundryShell theme={themeMode}>
      <FoundrySidebar
        activeItemId={sidebarActiveView}
        collapsed={sidebarCollapsed}
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
              {demoFallbackEnabled
                ? "Offline — showing demo data"
                : "Local API is not reachable"}
            </NoticeLine>
          ) : null}
          {apiState === "saving" ? <NoticeLine>Saving…</NoticeLine> : null}
          {apiState === "loading" ? <NoticeLine>Loading…</NoticeLine> : null}
          {notice ? <NoticeLine>{notice}</NoticeLine> : null}
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
            retryLabel="Reload this view"
          >
            {renderActiveView()}
          </ErrorBoundary>
        </FoundryView>
      </FoundryMain>
    </FoundryShell>
  );
}
