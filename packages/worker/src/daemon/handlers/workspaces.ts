import {
  daemonMessageTypes,
  type FindMovedWorkspacePayload,
  type ForgetWorkspacePayload,
  type RelinkWorkspacePayload,
  type SetupWorkspacePayload,
} from "@bd777/foundry-protocol";
import { registerExecutionWorkspace } from "../../repository-registry.js";
import { sendWebSocket } from "../../transport.js";
import {
  findMovedWorkspaceFolders,
  relinkWorkspaceFolder,
} from "../../workspace-folders.js";
import { inspectWorkspace } from "../../workspace-inspection.js";
import { existingWorkspaceFolder } from "../../workspace-registration.js";
import {
  forgetWorkspaceRegistration,
  initWorkspace,
  readWorkspace,
} from "../../workspaces.js";
import { logTime } from "../context.js";
import { reply, type DaemonDispatch } from "../dispatch.js";
import { errorMessage } from "../../utils.js";

/**
 * Finds the repositories of a folder just served, after the reply: it grows
 * with the folder's size. Issue preparation waits for it on the same lock.
 */
function prepareForIssues(
  workspacePath: string,
  workspaceId: string,
  kind: string,
): void {
  void registerExecutionWorkspace(workspacePath, workspaceId).then(
    (prepared) =>
      console.log(
        `Prepared ${kind} ${workspacePath}: ${prepared.repositories.length} repositories${prepared.errors.length ? `, ${prepared.errors.length} problems (first: ${prepared.errors[0]})` : ""}.`,
      ),
    (error: unknown) =>
      console.error(
        `Preparing ${kind} ${workspacePath} for Issues failed: ${errorMessage(error)}`,
      ),
  );
}

/** Adding, inspecting, forgetting and locating the device's workspaces. */
export function registerWorkspaceHandlers(dispatch: DaemonDispatch): void {
  dispatch
    .on(daemonMessageTypes.inspectWorkspace, (envelope, ctx) => {
      const payload = envelope.payload as {
        workspaceId: string;
        rescan?: boolean;
      };
      return reply(
        ctx,
        envelope,
        daemonMessageTypes.workspaceInspected,
        async () => ({
          inspection: await inspectWorkspace(
            ctx.roster.folderFor(payload.workspaceId),
            payload.workspaceId,
            payload.rescan === true,
          ),
        }),
      );
    })
    .on(daemonMessageTypes.setupWorkspace, (envelope, ctx) => {
      const payload = envelope.payload as SetupWorkspacePayload | undefined;
      if (!payload?.path) {
        sendWebSocket(
          ctx.socket,
          daemonMessageTypes.workspaceReady,
          { error: "setup_workspace requires path" },
          envelope.id,
        );
        return;
      }
      return reply(ctx, envelope, daemonMessageTypes.workspaceReady, () => {
        const workspacePath = existingWorkspaceFolder(payload.path);
        initWorkspace(workspacePath);
        // Chats work in the folder as soon as it is registered. A folder
        // without Git is left as it is until the person confirms setting Git
        // up for its first Issue.
        prepareForIssues(
          workspacePath,
          readWorkspace(workspacePath).id,
          "workspace",
        );
        const registration = ctx.roster.registration(workspacePath);
        ctx.roster.register(registration);
        return { registration };
      });
    })
    .on(daemonMessageTypes.forgetWorkspace, (envelope, ctx) => {
      const payload = envelope.payload as ForgetWorkspacePayload | undefined;
      if (!payload?.workspaceId && !payload?.path) {
        sendWebSocket(
          ctx.socket,
          daemonMessageTypes.workspaceForgotten,
          { error: "forget_workspace requires workspaceId or path" },
          envelope.id,
        );
        return;
      }
      return reply(
        ctx,
        envelope,
        daemonMessageTypes.workspaceForgotten,
        () => {
          const workspacePath =
            payload.path || ctx.roster.knownPath(payload.workspaceId) || "";
          forgetWorkspaceRegistration(payload.workspaceId ?? "", workspacePath);
          ctx.roster.unregister(payload.workspaceId ?? "", workspacePath);
          return { workspaceId: payload.workspaceId ?? "" };
        },
        (message) => ({
          workspaceId: payload.workspaceId ?? "",
          error: message,
        }),
      );
    })
    .on(daemonMessageTypes.relinkWorkspace, async (envelope, ctx) => {
      const payload = envelope.payload as RelinkWorkspacePayload | undefined;
      if (!payload?.workspaceId || !payload.path) {
        sendWebSocket(
          ctx.socket,
          daemonMessageTypes.workspaceRelinked,
          { error: "relink_workspace requires workspaceId and path" },
          envelope.id,
        );
        return;
      }
      const servedFrom = ctx.roster.knownPath(payload.workspaceId) ?? "";
      try {
        const relinked = await relinkWorkspaceFolder({
          ...payload,
          previousPath: payload.previousPath || servedFrom,
        });
        const workspacePath = relinked.workspace.path;
        ctx.roster.unregister(payload.workspaceId, servedFrom);
        // As for a new folder: its repositories are found again after the
        // reply (the registration already follows the folder).
        prepareForIssues(
          workspacePath,
          payload.workspaceId,
          "relinked workspace",
        );
        const registration = ctx.roster.registration(workspacePath);
        ctx.roster.register(registration);
        console.log(
          `${logTime()} Workspace ${payload.workspaceId} is served from ${workspacePath} now (was ${payload.previousPath || servedFrom || "unknown"}).`,
        );
        sendWebSocket(
          ctx.socket,
          daemonMessageTypes.workspaceRelinked,
          { registration, nativeSessions: relinked.nativeSessions },
          envelope.id,
        );
        ctx.roster.checkFolders();
      } catch (error) {
        sendWebSocket(
          ctx.socket,
          daemonMessageTypes.workspaceRelinked,
          { error: errorMessage(error) },
          envelope.id,
        );
      }
    })
    .on(daemonMessageTypes.findMovedWorkspace, (envelope, ctx) => {
      const payload = envelope.payload as FindMovedWorkspacePayload | undefined;
      const previousPath =
        payload?.previousPath ||
        (payload?.workspaceId ? ctx.roster.knownPath(payload.workspaceId) : "");
      if (!payload?.workspaceId || !previousPath) {
        sendWebSocket(
          ctx.socket,
          daemonMessageTypes.movedWorkspaceFound,
          {
            error: "find_moved_workspace requires workspaceId and previousPath",
          },
          envelope.id,
        );
        return;
      }
      return reply(
        ctx,
        envelope,
        daemonMessageTypes.movedWorkspaceFound,
        () => ({
          suggestions: findMovedWorkspaceFolders({
            workspaceId: payload.workspaceId,
            previousPath,
          }),
        }),
      );
    });
}
