import { useEffect, useRef, useState } from "react";
import { connectorTypes, type ConnectorType } from "../lib/connector-types";
import {
  parseAppRoute,
  pathForAppRoute,
  searchWithWorkspace,
  workspaceIdFromLocation,
  type AppRoute,
  type NavView,
} from "./navigation";

export interface UseAppRouteSyncInput {
  activeView: NavView;
  activeWorkspaceId: string;
  onPopState: (route: AppRoute, workspaceId: string) => void;
  selectedChatId: string;
  selectedIssueId: string;
  selectedDeviceId?: string;
  deviceSection?: AppRoute["deviceSection"];
}

export interface AppRouteSelection {
  /** The open Connectors tab; only the route reads it. */
  connectorTab: ConnectorType;
  setConnectorTab: (tab: ConnectorType) => void;
}

/** Keeps browser history and shell selection in sync across all features. */
export function useAppRouteSync({
  activeView,
  activeWorkspaceId,
  onPopState,
  selectedChatId,
  selectedIssueId,
  selectedDeviceId,
  deviceSection,
}: UseAppRouteSyncInput): AppRouteSelection {
  const routeSyncedRef = useRef(false);
  const [connectorTab, setConnectorTab] = useState<ConnectorType>(
    () =>
      parseAppRoute(window.location.pathname).connectorTab ?? connectorTypes[0],
  );
  const onPopStateRef = useRef(onPopState);
  onPopStateRef.current = onPopState;

  useEffect(() => {
    const handlePopState = (): void => {
      const route = parseAppRoute(window.location.pathname);
      if (route.connectorTab) setConnectorTab(route.connectorTab);
      onPopStateRef.current(route, workspaceIdFromLocation());
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    const nextRoute: AppRoute =
      activeView === "chats"
        ? { view: "chats", selectedChatId: selectedChatId || undefined }
        : activeView === "issue"
          ? { view: "issue", selectedIssueId: selectedIssueId || undefined }
          : activeView === "devices"
            ? { view: "devices", selectedDeviceId, deviceSection }
            : activeView === "locations"
              ? { view: "locations", selectedDeviceId }
              : activeView === "connectors"
                ? { view: "connectors", connectorTab }
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
    selectedIssueId,
    selectedDeviceId,
    deviceSection,
    connectorTab,
  ]);
  return { connectorTab, setConnectorTab };
}
