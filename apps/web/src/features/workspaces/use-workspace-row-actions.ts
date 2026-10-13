import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  DeviceProjection,
  WorkspaceProjection,
  WorkspaceRelinkResult,
} from "@bd777/foundry-protocol";
import type { WorkspaceEdit } from "../../components/workspace/workspace-editor";
import { errorText } from "../../lib/errors";

/**
 * What the Workspaces page's row actions did, said on the page: adding a
 * folder again, locating it, and the editor's add, rename and remove. Each
 * reloads the data afterwards and says so if that fails.
 */
export function useWorkspaceRowActions({
  activeWorkspaceId,
  workspaceCount,
  onAddAgain,
  onChanged,
}: {
  activeWorkspaceId: string;
  workspaceCount: number;
  onAddAgain: (
    workspace: WorkspaceProjection,
    device: DeviceProjection,
  ) => Promise<void>;
  onChanged: (change?: { removedWorkspaceId?: string }) => Promise<void>;
}) {
  const { t } = useTranslation("workspaces");
  const [message, setMessage] = useState("");
  const [changeError, setChangeError] = useState("");
  const [addingAgainId, setAddingAgainId] = useState("");
  // Once a folder is added again its button goes; focus moves to its row.
  const detailsButtons = useRef(new Map<string, HTMLButtonElement>());

  async function refresh(change?: { removedWorkspaceId?: string }) {
    try {
      await onChanged(change);
    } catch {
      setChangeError(t("deviceList.refreshFailed"));
    }
  }

  async function addAgain(
    workspace: WorkspaceProjection,
    device: DeviceProjection,
  ) {
    if (addingAgainId) return;
    setAddingAgainId(workspace.id);
    setMessage("");
    setChangeError("");
    try {
      await onAddAgain(workspace, device);
    } catch (cause) {
      setChangeError(errorText(cause, t("editor.saveFailed")));
      setAddingAgainId("");
      return;
    }
    setMessage(
      t("location.addedAgain", { name: workspace.name, device: device.label }),
    );
    await refresh();
    setAddingAgainId("");
    detailsButtons.current.get(workspace.id)?.focus();
  }

  async function relinked(result: WorkspaceRelinkResult) {
    setChangeError("");
    const { copied, notFound } = result.nativeSessions;
    setMessage(
      [
        t("location.located", {
          name: result.workspace.name,
          path: result.workspace.localPath,
        }),
        copied > 0 ? t("location.chatsResume", { count: copied }) : "",
        notFound > 0 ? t("location.chatsContinue", { count: notFound }) : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
    await refresh();
  }

  async function saved(
    edit: WorkspaceEdit,
    kind: WorkspaceEdit["kind"],
    workspace: WorkspaceProjection,
  ) {
    setChangeError("");
    setMessage(
      t(
        kind === "add"
          ? // With no workspace before, the first one becomes current.
            activeWorkspaceId || workspaceCount
            ? "deviceList.added"
            : "deviceList.addedFirst"
          : kind === "rename"
            ? "deviceList.renamed"
            : "deviceList.removed",
        { name: workspace.name },
      ),
    );
    await refresh(
      edit.kind === "remove"
        ? { removedWorkspaceId: edit.workspace.id }
        : undefined,
    );
  }

  return {
    message,
    changeError,
    addingAgainId,
    detailsButtons,
    clearMessage: () => setMessage(""),
    addAgain,
    relinked,
    saved,
  };
}
