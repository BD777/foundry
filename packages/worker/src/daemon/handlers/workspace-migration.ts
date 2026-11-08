import {
  daemonMessageTypes,
  type WorkspaceMigrationAbortPayload,
  type WorkspaceMigrationActivatePayload,
  type WorkspaceMigrationCheckPayload,
  type WorkspaceMigrationPurgePayload,
  type WorkspaceMigrationRescanPayload,
  type WorkspaceMigrationRetirePayload,
  type WorkspaceMigrationScanPayload,
  type WorkspaceMigrationTransferPayload,
  type WorkspaceMigrationVerifyPayload,
} from "@bd777/foundry-protocol";
import { daemonRequestHeaders } from "../../transport/server-http.js";
import { trySendWebSocket } from "../../transport/transport.js";
import { sessionWork } from "../../session-work/supervisor.js";
import { activateMigration } from "../workspace-migration/activate.js";
import {
  purgeMigratedSource,
  retireMigratedWorkspace,
} from "../workspace-migration/purge.js";
import {
  rescanForMigration,
  scanForMigration,
} from "../workspace-migration/source.js";
import {
  abortStaging,
  checkTarget,
  verifyStaging,
} from "../workspace-migration/target.js";
import {
  cancelMigrationTransfers,
  startMigrationTransfer,
  transferRunning,
} from "../workspace-migration/transfer.js";
import { currentSocket, logTime } from "../context.js";
import { reply, type DaemonDispatch } from "../dispatch.js";
import { prepareForIssues } from "./workspaces.js";

/**
 * Moving a workspace to another device (DEV-146): this device as the
 * source (scan, rescan, send, retire, purge) or the target (check,
 * receive, verify, activate, abort). The server drives every step.
 */
export function registerWorkspaceMigrationHandlers(
  dispatch: DaemonDispatch,
): void {
  dispatch
    .on(daemonMessageTypes.workspaceMigrationScan, (envelope, ctx) => {
      const payload = envelope.payload as WorkspaceMigrationScanPayload;
      return reply(
        ctx,
        envelope,
        daemonMessageTypes.workspaceMigrationScanned,
        () =>
          scanForMigration({
            migrationId: payload.migrationId,
            workspaceId: payload.workspaceId,
            path: payload.path || ctx.roster.folderFor(payload.workspaceId),
            nativeSessions: payload.nativeSessions ?? [],
          }),
      );
    })
    .on(daemonMessageTypes.workspaceMigrationCheck, (envelope, ctx) => {
      const payload = envelope.payload as WorkspaceMigrationCheckPayload;
      return reply(
        ctx,
        envelope,
        daemonMessageTypes.workspaceMigrationChecked,
        () => checkTarget({ path: payload.path, bytes: payload.bytes }),
      );
    })
    .on(daemonMessageTypes.workspaceMigrationTransfer, (envelope, ctx) => {
      const payload = envelope.payload as WorkspaceMigrationTransferPayload;
      return reply(
        ctx,
        envelope,
        daemonMessageTypes.workspaceMigrationTransferStarted,
        async () => {
          await startMigrationTransfer(payload, {
            serverURL: ctx.serverURL,
            headers: () => daemonRequestHeaders(false),
            // News goes over whichever control connection is open then.
            send: (progress) => {
              const socket = currentSocket();
              if (socket)
                trySendWebSocket(
                  socket,
                  daemonMessageTypes.workspaceMigrationProgress,
                  progress,
                );
            },
          });
          return {};
        },
      );
    })
    .on(daemonMessageTypes.workspaceMigrationVerify, (envelope, ctx) => {
      const payload = envelope.payload as WorkspaceMigrationVerifyPayload;
      return reply(
        ctx,
        envelope,
        daemonMessageTypes.workspaceMigrationVerified,
        () => verifyStaging(payload),
      );
    })
    .on(daemonMessageTypes.workspaceMigrationRescan, (envelope, ctx) => {
      const payload = envelope.payload as WorkspaceMigrationRescanPayload;
      return reply(
        ctx,
        envelope,
        daemonMessageTypes.workspaceMigrationRescanned,
        () =>
          rescanForMigration({
            migrationId: payload.migrationId,
            workspaceId: payload.workspaceId,
            path: payload.path || ctx.roster.folderFor(payload.workspaceId),
            nativeSessions: payload.nativeSessions ?? [],
          }),
      );
    })
    .on(daemonMessageTypes.workspaceMigrationActivate, (envelope, ctx) => {
      const payload = envelope.payload as WorkspaceMigrationActivatePayload;
      return reply(
        ctx,
        envelope,
        daemonMessageTypes.workspaceMigrationActivated,
        async () => {
          if (transferRunning(payload.migrationId))
            throw new Error("A transfer of this migration is still running");
          const activated = await activateMigration(
            {
              migrationId: payload.migrationId,
              workspaceId: payload.workspaceId,
              name: payload.name,
              path: payload.path,
              previousPath: payload.previousPath,
              nativeSessions: payload.nativeSessions ?? [],
            },
            { sessionWork: sessionWork() },
          );
          const workspacePath = activated.workspace.path;
          prepareForIssues(
            workspacePath,
            payload.workspaceId,
            "migrated workspace",
          );
          const registration = ctx.roster.registration(workspacePath);
          ctx.roster.register(registration);
          console.log(
            `${logTime()} Workspace ${payload.workspaceId} moved here to ${workspacePath} (was ${payload.previousPath} on another device).`,
          );
          ctx.roster.checkFolders();
          return {
            registration,
            nativeSessions: activated.nativeSessions,
            executionRoot: activated.executionRoot,
            previousExecutionRoot: activated.previousExecutionRoot,
          };
        },
      );
    })
    .on(daemonMessageTypes.workspaceMigrationRetire, (envelope, ctx) => {
      const payload = envelope.payload as WorkspaceMigrationRetirePayload;
      return reply(
        ctx,
        envelope,
        daemonMessageTypes.workspaceMigrationRetired,
        async () => {
          await cancelMigrationTransfers(payload.migrationId);
          const path = retireMigratedWorkspace(payload, {
            path: ctx.roster.knownPath(payload.workspaceId),
          });
          ctx.roster.unregister(payload.workspaceId, path);
          console.log(
            `${logTime()} Workspace ${payload.workspaceId} moved to device ${payload.targetDeviceId}; ${path} is kept, no longer served.`,
          );
          ctx.roster.checkFolders();
          return {};
        },
      );
    })
    .on(daemonMessageTypes.workspaceMigrationAbort, (envelope, ctx) => {
      const payload = envelope.payload as WorkspaceMigrationAbortPayload;
      return reply(
        ctx,
        envelope,
        daemonMessageTypes.workspaceMigrationAborted,
        async () => {
          await cancelMigrationTransfers(payload.migrationId);
          await abortStaging(payload);
          return {};
        },
      );
    })
    .on(daemonMessageTypes.workspaceMigrationPurge, (envelope, ctx) => {
      const payload = envelope.payload as WorkspaceMigrationPurgePayload;
      return reply(
        ctx,
        envelope,
        daemonMessageTypes.workspaceMigrationPurged,
        () => purgeMigratedSource(payload, { sessionWork: sessionWork() }),
        (message) => ({
          removed: [],
          changed: [],
          bytes: 0,
          done: false,
          error: message,
        }),
      );
    });
}
