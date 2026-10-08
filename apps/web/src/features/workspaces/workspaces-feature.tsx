import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  DeviceProjection,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { prefetchFoundryWorkspace } from "../../api";
import { WorkspaceSelectionPanel } from "./workspace-selection-panel";

export type WorkspacesFeatureEvent =
  | { type: "workspace.browse.requested" }
  | { type: "workspace.return.requested" }
  | {
      type: "workspace.activation.requested";
      workspaceId: string;
      notice?: string;
      /**
       * The /locations chooser switches in place: the active device+workspace
       * changes, but the view stays on the chooser instead of entering the
       * workspace overview.
       */
      stayOnLocation?: boolean;
    }
  | { type: "device.open.requested"; deviceId: string }
  /** A folder was added, renamed or removed; resolves once data reloaded. */
  | { type: "workspaces.changed" };

export interface WorkspacesFeatureProps {
  compact?: boolean;
  activeWorkspaceId: string;
  devices: DeviceProjection[];
  /** The device whose group the page brings into view. */
  focusDeviceId?: string;
  onEvent: (event: WorkspacesFeatureEvent) => Promise<boolean | void> | void;
  workspaces: WorkspaceProjection[];
}

/** Previewing a device never changes the active location. */
export function WorkspacesFeature(props: WorkspacesFeatureProps) {
  const { t } = useTranslation("workspaces");
  const [busyWorkspaceId, setBusyWorkspaceId] = useState("");
  const [error, setError] = useState("");
  const selecting = useRef(false);
  async function select(
    workspace: WorkspaceProjection,
    options: { stayOnLocation?: boolean } = {},
  ) {
    if (selecting.current) return false;
    if (workspace.id === props.activeWorkspaceId) {
      void props.onEvent({ type: "workspace.return.requested" });
      return true;
    }
    selecting.current = true;
    setBusyWorkspaceId(workspace.id);
    setError("");
    try {
      const result = await props.onEvent({
        type: "workspace.activation.requested",
        workspaceId: workspace.id,
        notice: t("switcher.activated", { name: workspace.name }),
        stayOnLocation: options.stayOnLocation,
      });
      if (result === false) throw new Error("Switch failed");
      return true;
    } catch {
      setError(t("switcher.failed", { name: workspace.name }));
      return false;
    } finally {
      selecting.current = false;
      setBusyWorkspaceId("");
    }
  }
  return (
    <WorkspaceSelectionPanel
      {...props}
      busyWorkspaceId={busyWorkspaceId}
      error={error}
      onReset={() => setError("")}
      onSelect={select}
      onPrepare={(workspace) => {
        if (workspace.id !== props.activeWorkspaceId && !selecting.current)
          prefetchFoundryWorkspace(workspace.id);
      }}
      onOpenDevice={(deviceId) =>
        void props.onEvent({ type: "device.open.requested", deviceId })
      }
      onChanged={async () => {
        await props.onEvent({ type: "workspaces.changed" });
      }}
      onBrowse={() =>
        void props.onEvent({ type: "workspace.browse.requested" })
      }
      onReturn={() =>
        void props.onEvent({ type: "workspace.return.requested" })
      }
    />
  );
}
