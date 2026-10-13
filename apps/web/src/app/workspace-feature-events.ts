import type { WorkspacesFeatureEvent } from "../features/workspaces";
import { clearWorkspaceSelection } from "./navigation";
import type { AppLocation } from "./use-app-location";
import type { WorkspaceData } from "./use-workspace-data";
import { workspacesViewFields } from "./view-fields";

/**
 * Handles the Workspaces feature's events, from the sidebar switcher and the
 * Workspaces page alike. Resolves whether a requested switch loaded.
 */
export function workspaceFeatureEventHandler(
  location: AppLocation,
  { activeWorkspaceId, data, loadWorkspace, refreshData }: WorkspaceData,
) {
  return async (event: WorkspacesFeatureEvent): Promise<boolean | void> => {
    if (event.type === "workspace.browse.requested") {
      location.setSelectedDeviceId(undefined);
      location.setActiveView("locations");
      return;
    }
    if (event.type === "workspace.return.requested") {
      location.setActiveView("workspace");
      return;
    }
    if (event.type === "device.open.requested") {
      location.openDevices(event.deviceId, "agents");
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
        location.setActiveView("workspace");
      }
      return loaded;
    }
  };
}
