import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { preferredChatId } from "../features/chat";
import type { DeviceSection } from "../features/devices";
import { preferredIssueId } from "../lib/issue-meta";
import {
  parseAppRoute,
  workspaceScopedViews,
  type AppRoute,
  type NavView,
  type SidebarView,
} from "./navigation";
import { initialFoundryData } from "./use-workspace-data";

/** Where the app is: the page shown and what is selected on it. */
export interface AppLocation {
  activeView: NavView;
  setActiveView: Dispatch<SetStateAction<NavView>>;
  selectedDeviceId: string | undefined;
  setSelectedDeviceId: Dispatch<SetStateAction<string | undefined>>;
  deviceSection: DeviceSection;
  setDeviceSection: Dispatch<SetStateAction<DeviceSection>>;
  chatView: "active" | "archived";
  selectedChatId: string;
  /** Data reconciliation preserves the selected chat view. */
  setSelectedChatId: Dispatch<SetStateAction<string>>;
  /** An explicit chat choice opens its transcript instead of Archived. */
  selectChat: (chatId: string) => void;
  selectedIssueId: string;
  setSelectedIssueId: Dispatch<SetStateAction<string>>;
  /** Shows a route the browser went back or forward to. */
  showRoute: (route: AppRoute) => void;
  /** Opens the Devices page on a device (or the list), keeping the section unless given. */
  openDevices: (deviceId: string | undefined, section?: DeviceSection) => void;
  openIssue: (issueId: string) => void;
  selectSidebarView: (view: SidebarView) => void;
}

/** The page and selections, starting from the URL the app opened at. */
export function useAppLocation(): AppLocation {
  const [initialRoute] = useState<AppRoute>(() =>
    parseAppRoute(window.location.pathname),
  );
  const [activeView, setActiveView] = useState<NavView>(initialRoute.view);
  const [selectedDeviceId, setSelectedDeviceId] = useState(
    initialRoute.selectedDeviceId,
  );
  const [deviceSection, setDeviceSection] = useState<DeviceSection>(
    initialRoute.deviceSection ?? "agents",
  );
  const [chatView, setChatView] = useState<"active" | "archived">(
    initialRoute.chatView ?? "active",
  );
  const [selectedChatId, updateSelectedChatId] = useState(
    () =>
      initialRoute.selectedChatId ??
      preferredChatId(initialFoundryData().chats),
  );
  const [selectedIssueId, setSelectedIssueId] = useState(
    () =>
      initialRoute.selectedIssueId ??
      preferredIssueId(initialFoundryData().issues),
  );

  const selectChat = useCallback((chatId: string) => {
    setChatView("active");
    updateSelectedChatId(chatId);
  }, []);

  return {
    activeView,
    setActiveView,
    selectedDeviceId,
    setSelectedDeviceId,
    deviceSection,
    setDeviceSection,
    chatView,
    selectedChatId,
    setSelectedChatId: updateSelectedChatId,
    selectChat,
    selectedIssueId,
    setSelectedIssueId,
    showRoute: (route) => {
      setActiveView(route.view);
      setChatView(route.chatView ?? "active");
      setSelectedDeviceId(route.selectedDeviceId);
      setDeviceSection(route.deviceSection ?? "agents");
      if (route.selectedChatId !== undefined) {
        updateSelectedChatId(route.selectedChatId);
      } else if (route.view === "chats") {
        updateSelectedChatId("");
      }
      if (route.selectedIssueId !== undefined) {
        setSelectedIssueId(route.selectedIssueId);
      }
    },
    openDevices: (deviceId, section) => {
      setSelectedDeviceId(deviceId);
      if (section) setDeviceSection(section);
      setActiveView("devices");
    },
    openIssue: (issueId) => {
      setSelectedIssueId(issueId);
      setActiveView("issue");
    },
    selectSidebarView: (view) => {
      setActiveView(view);
      if (view === "chats") setChatView("active");
      if (view === "devices") setSelectedDeviceId(undefined);
    },
  };
}

/**
 * Until a workspace is added or switched to, a workspace's views have
 * nothing to show; the Workspaces page is where to choose one.
 */
export function useWorkspaceChoiceRedirect(
  needsWorkspace: boolean,
  { activeView, setActiveView }: AppLocation,
): void {
  useEffect(() => {
    if (needsWorkspace && workspaceScopedViews.has(activeView))
      setActiveView("locations");
  }, [needsWorkspace, activeView]);
}
