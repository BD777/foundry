import { useEffect, useRef } from "react";
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

/** Keeps browser history and shell selection in sync across all features. */
export function useAppRouteSync({
  activeView,
  activeWorkspaceId,
  onPopState,
  selectedChatId,
  selectedIssueId,
  selectedDeviceId,
  deviceSection,
}: UseAppRouteSyncInput): void {
  const routeSyncedRef = useRef(false);
  const onPopStateRef = useRef(onPopState);
  onPopStateRef.current = onPopState;

  useEffect(() => {
    const handlePopState = (): void => {
      onPopStateRef.current(
        parseAppRoute(window.location.pathname),
        workspaceIdFromLocation(),
      );
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
  ]);
}
