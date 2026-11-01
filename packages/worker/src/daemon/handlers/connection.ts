import { executionHostClient } from "../../execution-host/client.js";
import {
  daemonMessageTypes,
  type SessionTurnPayload,
} from "@bd777/foundry-protocol";
import { setSessionTurnSink } from "../../session-state.js";
import { trySendWebSocket } from "../../transport.js";
import type { DaemonDispatch } from "../dispatch.js";
import { configureAttachmentPreviewPush } from "../attachment-previews.js";
import { serveResources } from "./resources.js";
import { noteDaemonHealth } from "../../daemon-health.js";

/** The server's answers about the connection itself. */
export function registerConnectionHandlers(dispatch: DaemonDispatch): void {
  dispatch
    .on(daemonMessageTypes.error, (envelope, ctx) => {
      ctx.roster.registrationTaken(envelope.id);
      console.error(
        `Server error: ${envelope.error ?? "unknown websocket error"}`,
      );
      // A session message the server could not store goes again later.
      if (ctx.sessionTransport.retryAfterError(envelope.id)) return;
      // A refused registration leaves this socket unable to do anything:
      // reconnect with backoff rather than sit connected and offline.
      if (!ctx.state.registered) {
        ctx.state.refused = true;
        ctx.socket.close(1008, "registration refused");
      }
    })
    .on(daemonMessageTypes.ack, (envelope, ctx) => {
      const seq = (envelope.payload as { replyChunkSeq?: number } | undefined)
        ?.replyChunkSeq;
      if (typeof seq === "number")
        ctx.sessionTransport.acknowledgePiece(envelope.id, seq, ctx.socket);
      else ctx.sessionTransport.acknowledge(envelope.id);
    })
    .on(daemonMessageTypes.registrationNeeded, (envelope, ctx) => {
      // A registration left out sections the server does not have (it
      // restarted): it goes again whole.
      ctx.roster.registrationNeeded(envelope.id);
    })
    .on(daemonMessageTypes.registered, (envelope, ctx) => {
      ctx.roster.registrationTaken(envelope.id);
      ctx.state.registered = true;
      noteDaemonHealth({ connectedAt: new Date().toISOString() });
      ctx.sessionTransport.bind(ctx.socket, {
        replyChunks: true,
        replyChunkAck: true,
      });
      configureAttachmentPreviewPush(ctx.serverURL, true, (folder) => {
        const id = ctx.roster.workspaceIdForFolder(folder);
        return id ? { id, path: ctx.roster.pathFor(id) } : undefined;
      });
      ctx.roster.registered = true;
      ctx.roster.checkFolders();
      serveResources(ctx);
      // Timer-driven background turns arrive while no Foundry turn is
      // active; route their events over this socket as ordinary
      // session_event envelopes the server persists and broadcasts.
      ctx.routeOutOfBandEvents();
      // The turns Claude runs on its own; those running now are told again
      // (the server forgets them when the device goes).
      setSessionTurnSink((sessionId, running) =>
        ctx.sessionTransport.send(daemonMessageTypes.sessionTurn, {
          sessionId,
          running,
        } satisfies SessionTurnPayload),
      );
      executionHostClient()?.reportOwnTurns();
      // The session runner's version and switch.
      const socket = ctx.socket;
      executionHostClient()?.setRunnerSink((runner) =>
        trySendWebSocket(socket, daemonMessageTypes.executionRunner, runner),
      );
      ctx.announceAdditionalIssueCapacity();
      if (ctx.once && ctx.idleTimeoutMs > 0) {
        ctx.state.idleTimer = setTimeout(
          () => ctx.finish("exit"),
          ctx.idleTimeoutMs,
        );
      }
    });
}
