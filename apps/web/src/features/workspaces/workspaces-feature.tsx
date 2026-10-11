import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  DeviceProjection,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { createWorkspace, prefetchFoundryWorkspace } from "../../api";
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

/**
 * How long the pointer (or focus) rests on a workspace before what a switch
 * to it reads is read ahead: passing over a list reads nothing.
 */
export const workspaceSwitchIntentMs = 300;

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
  const intent = useSwitchIntent();
  async function select(
    workspace: WorkspaceProjection,
    options: { stayOnLocation?: boolean } = {},
  ) {
    if (selecting.current) return false;
    intent.end();
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
          intent.start(workspace.id);
      }}
      onPrepareEnd={intent.end}
      onOpenDevice={(deviceId) =>
        void props.onEvent({ type: "device.open.requested", deviceId })
      }
      onChanged={async () => {
        await props.onEvent({ type: "workspaces.changed" });
      }}
      onAddAgain={async (workspace, device) => {
        // The add-folder flow, for the same path on the same device: the
        // folder keeps its identity, so the workspace and its history return.
        await createWorkspace({
          deviceId: device.id,
          path: workspace.localPath,
        });
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

/** Reads ahead for a switch once the person rests on a workspace. */
function useSwitchIntent() {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const end = () => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
  };
  useEffect(() => end, []);
  return {
    start(workspaceId: string) {
      end();
      timer.current = setTimeout(() => {
        timer.current = undefined;
        prefetchFoundryWorkspace(workspaceId);
      }, workspaceSwitchIntentMs);
    },
    end,
  };
}
