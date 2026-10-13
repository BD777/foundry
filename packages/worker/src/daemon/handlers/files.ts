import {
  daemonMessageTypes,
  subagentDigestView,
  type AgentSubagentSummary,
  type AgentSubagentTranscript,
  type AttachmentReadPayload,
  type AttachmentWritePayload,
  type BackgroundTaskRequestPayload,
  type ListDirectoriesPayload,
  type ListSubagentsPayload,
  type ListWorkspaceTreePayload,
  type ReadFilePayload,
  type ReadSessionFileDiffPayload,
  type ReadSessionFilePayload,
  type ReadSubagentTranscriptPayload,
} from "@bd777/foundry-protocol";
import {
  claudeBackgroundTaskLog,
  claudeBackgroundTaskOutput,
  stopClaudeBackgroundTask,
} from "../../runner/active-runtimes.js";
import { readSessionFile, readSessionFileDiff } from "../../session-files.js";
import { readSessionUsage } from "../../session-usage.js";
import { duringActivity } from "../../stall-monitor.js";
import {
  listAgentSubagentDigests,
  listAgentSubagents,
  readAgentSubagentTranscript,
} from "../../subagent-transcript.js";
import { sendWebSocket, trySendWebSocket } from "../../transport.js";
import {
  AttachmentError,
  abortAttachmentUpload,
  readAttachmentImageChunk,
  readWorkspaceFileChunk,
  writeAttachmentChunk,
} from "../../workspace-attachments.js";
import {
  safeDirectoryListing,
  safeWorkspaceFileRead,
  safeWorkspaceTreeListing,
} from "../../workspace-files.js";
import { reply, type DaemonDispatch } from "../dispatch.js";

const attachmentError = (message: string, error: unknown) => ({
  error: message,
  code: error instanceof AttachmentError ? error.code : undefined,
});

/** A session's subagents, whole or as a chat shows them (the digest view). */
export async function subagentList(
  workspacePath: string,
  payload: ListSubagentsPayload,
) {
  return payload.view === subagentDigestView
    ? {
        sessionId: payload.sessionId,
        view: subagentDigestView,
        subagents: await listAgentSubagentDigests(
          workspacePath,
          payload.sessionId,
        ),
      }
    : {
        sessionId: payload.sessionId,
        subagents: await listAgentSubagents(workspacePath, payload.sessionId),
      };
}

/** Files of workspaces and sessions, attachments, and background task logs. */
export function registerFileHandlers(dispatch: DaemonDispatch): void {
  dispatch
    .on(daemonMessageTypes.attachmentWrite, (envelope, ctx) => {
      const payload = envelope.payload as AttachmentWritePayload;
      return reply(
        ctx,
        envelope,
        daemonMessageTypes.attachmentWritten,
        () => {
          const workspacePath = ctx.roster.folderFor(payload.workspaceId);
          if (payload.abort) {
            abortAttachmentUpload(workspacePath, payload.relativePath);
            return { size: 0 };
          }
          return writeAttachmentChunk({
            workspacePath,
            relativePath: payload.relativePath,
            offset: payload.offset,
            data: Buffer.from(payload.dataBase64 ?? "", "base64"),
            final: payload.final === true,
          });
        },
        attachmentError,
      );
    })
    .on(daemonMessageTypes.attachmentRead, (envelope, ctx) => {
      const payload = envelope.payload as AttachmentReadPayload;
      return reply(
        ctx,
        envelope,
        daemonMessageTypes.attachmentChunkRead,
        () => {
          const read =
            payload.scope === "workspace"
              ? readWorkspaceFileChunk
              : readAttachmentImageChunk;
          const chunk = read({
            workspacePath: ctx.roster.folderFor(payload.workspaceId),
            path: payload.path,
            offset: payload.offset,
            maxBytes: payload.maxBytes,
          });
          return {
            size: chunk.size,
            mimeType: chunk.mimeType,
            dataBase64: chunk.data.toString("base64"),
          };
        },
        attachmentError,
      );
    })
    .on(daemonMessageTypes.readFile, (envelope, ctx) => {
      const payload = envelope.payload as ReadFilePayload | undefined;
      if (!payload?.path) {
        console.error("Received read_file without a path payload.");
        return;
      }
      return reply(
        ctx,
        envelope,
        daemonMessageTypes.fileRead,
        () =>
          safeWorkspaceFileRead(
            ctx.roster.folderFor(payload.workspaceId),
            payload,
          ),
        (message) => ({
          workspaceId: payload.workspaceId,
          path: payload.path,
          content: "",
          truncated: false,
          error: message,
        }),
      );
    })
    .on(daemonMessageTypes.readSessionFile, (envelope, ctx) => {
      const payload = (envelope.payload ??
        {}) as Partial<ReadSessionFilePayload>;
      return reply(
        ctx,
        envelope,
        daemonMessageTypes.sessionFileRead,
        () => ({
          ...readSessionFile({
            workspacePath: ctx.roster.folderFor(payload.workspaceId ?? ""),
            sessionId: payload.sessionId ?? "",
            path: payload.path ?? "",
          }),
        }),
        (message) => ({
          sessionId: payload.sessionId ?? "",
          path: payload.path ?? "",
          origin: "tool",
          insideWorkspace: false,
          kind: "missing",
          truncated: false,
          changedSinceRecorded: false,
          error: message,
        }),
      );
    })
    .on(daemonMessageTypes.readSessionFileDiff, (envelope, ctx) => {
      const payload = (envelope.payload ??
        {}) as Partial<ReadSessionFileDiffPayload>;
      return reply(
        ctx,
        envelope,
        daemonMessageTypes.sessionFileDiffRead,
        async () => ({
          ...(await readSessionFileDiff({
            workspacePath: ctx.roster.folderFor(payload.workspaceId ?? ""),
            sessionId: payload.sessionId ?? "",
            path: payload.path ?? "",
            inputId: payload.inputId || undefined,
          })),
        }),
        (message) => ({
          sessionId: payload.sessionId ?? "",
          path: payload.path ?? "",
          origin: "tool",
          insideWorkspace: false,
          source: "hook",
          beforeLabel: "beforeEdits",
          afterLabel: "afterEdits",
          mayIncludeOtherEdits: false,
          changedSince: false,
          truncated: false,
          binary: false,
          tooLarge: false,
          error: message,
        }),
      );
    })
    // The request names a task, never a path: the device reads the log it
    // recorded for that task of that session. A reader that follows a running
    // task's log is told when it grows (backgroundTaskOutputChanged) and
    // continues from `after`.
    .on(daemonMessageTypes.readBackgroundTaskOutput, (envelope, ctx) => {
      const payload = (envelope.payload ??
        {}) as Partial<BackgroundTaskRequestPayload>;
      return reply(
        ctx,
        envelope,
        daemonMessageTypes.backgroundTaskOutputRead,
        () => {
          const sessionId = payload.sessionId ?? "";
          const taskId = payload.taskId ?? "";
          const output = claudeBackgroundTaskOutput({
            workspacePath: ctx.roster.folderFor(payload.workspaceId ?? ""),
            sessionId,
            taskId,
            after: payload.after,
          });
          const following =
            payload.follow === true &&
            output.kind !== "binary" &&
            ctx.outputFollowers.follow(sessionId, taskId, output.bytes, () =>
              claudeBackgroundTaskLog(sessionId, taskId),
            );
          return { ...output, ...(following ? { following } : {}) };
        },
        (message) => ({
          sessionId: payload.sessionId ?? "",
          taskId: payload.taskId ?? "",
          content: "",
          truncated: false,
          bytes: 0,
          kind: "missing",
          error: message,
        }),
      );
    })
    .on(daemonMessageTypes.stopBackgroundTask, (envelope, ctx) => {
      const payload = (envelope.payload ??
        {}) as Partial<BackgroundTaskRequestPayload>;
      const sessionId = payload.sessionId?.trim() ?? "";
      const taskId = payload.taskId?.trim() ?? "";
      return reply(
        ctx,
        envelope,
        daemonMessageTypes.backgroundTaskStopped,
        async () => {
          await stopClaudeBackgroundTask(sessionId, taskId);
          return { sessionId, taskId };
        },
        (message) => ({ sessionId, taskId, error: message }),
      );
    })
    .on(daemonMessageTypes.readSessionUsage, (envelope, ctx) => {
      void duringActivity("session usage", () =>
        readSessionUsage(envelope.payload),
      ).then((value) =>
        trySendWebSocket(
          ctx.socket,
          daemonMessageTypes.sessionUsageRead,
          value,
          envelope.id,
        ),
      );
    })
    .on(daemonMessageTypes.readSubagentTranscript, (envelope, ctx) => {
      const payload = envelope.payload as
        ReadSubagentTranscriptPayload | undefined;
      const failed = (error: string) =>
        ({
          sessionId: payload?.sessionId ?? "",
          taskId: payload?.taskId ?? "",
          title: "Subagent",
          toolUseId: "",
          status: "failed",
          messages: [],
          error,
        }) satisfies AgentSubagentTranscript & { error: string };
      if (!payload?.workspaceId || !payload.sessionId || !payload.taskId) {
        sendWebSocket(
          ctx.socket,
          daemonMessageTypes.subagentTranscriptRead,
          failed("workspaceId, sessionId, and taskId are required"),
          envelope.id,
        );
        return;
      }
      return reply(
        ctx,
        envelope,
        daemonMessageTypes.subagentTranscriptRead,
        () =>
          readAgentSubagentTranscript(
            ctx.roster.folderFor(payload.workspaceId),
            payload.sessionId,
            payload.taskId,
          ),
        failed,
      );
    })
    .on(daemonMessageTypes.listSubagents, (envelope, ctx) => {
      const payload = envelope.payload as ListSubagentsPayload | undefined;
      const failed = (error: string) => ({
        sessionId: payload?.sessionId ?? "",
        subagents: [] as AgentSubagentSummary[],
        error,
      });
      if (!payload?.workspaceId || !payload.sessionId) {
        sendWebSocket(
          ctx.socket,
          daemonMessageTypes.subagentsListed,
          failed("workspaceId and sessionId are required"),
          envelope.id,
        );
        return;
      }
      return reply(
        ctx,
        envelope,
        daemonMessageTypes.subagentsListed,
        () => subagentList(ctx.roster.folderFor(payload.workspaceId), payload),
        failed,
      );
    })
    .on(daemonMessageTypes.listDirectories, (envelope, ctx) => {
      const payload = envelope.payload as ListDirectoriesPayload | undefined;
      if (!payload?.path) {
        sendWebSocket(
          ctx.socket,
          daemonMessageTypes.directoriesListed,
          {
            path: "",
            directories: [],
            error: "list_directories requires path",
          },
          envelope.id,
        );
        return;
      }
      return reply(
        ctx,
        envelope,
        daemonMessageTypes.directoriesListed,
        () => ({
          path: payload.path,
          directories: safeDirectoryListing(payload.path),
        }),
        (message) => ({ path: payload.path, directories: [], error: message }),
      );
    })
    .on(daemonMessageTypes.listWorkspaceTree, (envelope, ctx) => {
      const payload = envelope.payload as ListWorkspaceTreePayload | undefined;
      const failed = (error: string) => ({
        entries: [],
        error,
        path: payload?.path ?? "",
        workspaceId: payload?.workspaceId ?? "",
      });
      if (!payload?.workspaceId) {
        sendWebSocket(
          ctx.socket,
          daemonMessageTypes.workspaceTreeListed,
          failed("list_workspace_tree requires workspaceId"),
          envelope.id,
        );
        return;
      }
      return reply(
        ctx,
        envelope,
        daemonMessageTypes.workspaceTreeListed,
        () => ({
          entries: safeWorkspaceTreeListing(
            ctx.roster.folderFor(payload.workspaceId),
            payload.path,
          ),
          path: payload.path ?? "",
          workspaceId: payload.workspaceId,
        }),
        failed,
      );
    });
}
