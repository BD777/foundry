import { useEffect, useRef, useState } from "react";
import type { AssistantSettingsSection } from "../lib/assistant-settings-sections";
import {
  defaultConnectorType,
  type ConnectorType,
} from "../lib/connector-types";
import { issuesEnabled } from "../lib/feature-flags";
import { providerTabFrom, type ProviderTab } from "../lib/provider-tabs";
import {
  parseAppRoute,
  pathForAppRoute,
  type AppRoute,
  type NavView,
} from "../lib/routes";
import {
  searchWithWorkspace,
  workspaceIdFromLocation,
} from "../lib/in-app-navigation";

export interface UseAppRouteSyncInput {
  activeView: NavView;
  activeWorkspaceId: string;
  onPopState: (route: AppRoute, workspaceId: string) => void;
  chatView?: "active" | "archived";
  selectedChatId: string;
  selectedAssistantId?: string;
  selectedIssueId: string;
  selectedDeviceId?: string;
  deviceSection?: AppRoute["deviceSection"];
}

export interface AppRouteSelection {
  /** The open Connectors tab; only the route reads it. */
  connectorTab: ConnectorType;
  setConnectorTab: (tab: ConnectorType) => void;
  /** The open Model providers tab; only the route reads it. */
  providerTab: ProviderTab;
  setProviderTab: (tab: ProviderTab) => void;
  /** The open section of the assistant's settings; only the route reads it. */
  assistantSection?: AssistantSettingsSection;
  setAssistantSection: (section?: AssistantSettingsSection) => void;
}

/** Keeps browser history and shell selection in sync across all features. */
export function useAppRouteSync({
  activeView,
  activeWorkspaceId,
  onPopState,
  selectedChatId,
  selectedAssistantId,
  chatView,
  selectedIssueId,
  selectedDeviceId,
  deviceSection,
}: UseAppRouteSyncInput): AppRouteSelection {
  const routeSyncedRef = useRef(false);
  const [connectorTab, setConnectorTab] = useState<ConnectorType>(
    () =>
      parseAppRoute(window.location.pathname).connectorTab ??
      defaultConnectorType,
  );
  const [providerTab, setProviderTab] = useState<ProviderTab>(
    () =>
      parseAppRoute(window.location.pathname).providerTab ??
      providerTabFrom(undefined),
  );
  const [assistantSection, setAssistantSection] = useState<
    AssistantSettingsSection | undefined
  >(() => parseAppRoute(window.location.pathname).assistantSection);
  const onPopStateRef = useRef(onPopState);
  onPopStateRef.current = onPopState;

  useEffect(() => {
    const handlePopState = (): void => {
      let route = parseAppRoute(window.location.pathname);
      // While Issues are off an Issue address shows chats: it is corrected
      // in place, so going back and forth never lands on it again.
      if (
        !issuesEnabled &&
        (route.view === "issues" || route.view === "issue")
      ) {
        route = { view: "chats" };
        window.history.replaceState(
          null,
          "",
          `${pathForAppRoute(route)}${window.location.search}${window.location.hash}`,
        );
      }
      if (route.connectorTab) setConnectorTab(route.connectorTab);
      if (route.providerTab) setProviderTab(route.providerTab);
      if (route.view === "assistantSettings")
        setAssistantSection(route.assistantSection);
      onPopStateRef.current(route, workspaceIdFromLocation());
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    const nextRoute: AppRoute =
      activeView === "chats"
        ? {
            view: "chats",
            chatView,
            selectedChatId: selectedChatId || undefined,
          }
        : activeView === "issue"
          ? { view: "issue", selectedIssueId: selectedIssueId || undefined }
          : activeView === "devices"
            ? { view: "devices", selectedDeviceId, deviceSection }
            : activeView === "locations"
              ? { view: "locations", selectedDeviceId }
              : activeView === "connectors"
                ? { view: "connectors", connectorTab }
                : activeView === "profiles"
                  ? { view: "profiles", providerTab }
                  : activeView === "assistantSettings"
                    ? {
                        view: "assistantSettings",
                        assistantId: selectedAssistantId,
                        assistantSection,
                      }
                    : activeView === "assistant"
                      ? {
                          view: "assistant",
                          assistantId: selectedAssistantId,
                        }
                      : { view: activeView };
    const nextPath = pathForAppRoute(nextRoute);
    const nextUrl = `${nextPath}${searchWithWorkspace(activeWorkspaceId)}${window.location.hash}`;
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (nextUrl === currentUrl) {
      routeSyncedRef.current = true;
      return;
    }
    if (!routeSyncedRef.current) {
      window.history.replaceState(null, "", nextUrl);
      routeSyncedRef.current = true;
      return;
    }
    window.history.pushState(null, "", nextUrl);
  }, [
    activeView,
    activeWorkspaceId,
    selectedChatId,
    selectedAssistantId,
    chatView,
    selectedIssueId,
    selectedDeviceId,
    deviceSection,
    connectorTab,
    providerTab,
    assistantSection,
  ]);
  return {
    connectorTab,
    setConnectorTab,
    providerTab,
    setProviderTab,
    assistantSection,
    setAssistantSection,
  };
}
