import {
  daemonMessageTypes,
  type SessionTimers,
  type SessionTurnPayload,
} from "@bd777/foundry-protocol";
import { setSessionTurnSink } from "../../session-state.js";
import { sessionTimers } from "../../session-timers.js";
import { serverFeatures } from "../../transport.js";
import type { DaemonDispatch } from "../dispatch.js";
import { serveResources } from "./resources.js";

/** The server's answers about the connection itself, and its session timers. */
export function registerConnectionHandlers(dispatch: DaemonDispatch): void {
  dispatch
    .on(daemonMessageTypes.error, (envelope, ctx) => {
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
      ctx.sessionTransport.acknowledge(envelope.id);
    })
    .on(daemonMessageTypes.registered, (envelope, ctx) => {
      ctx.state.registered = true;
      // A server that takes large envelopes in pieces says so here, and
      // one that takes news of workspace folders gone or back.
      const features = serverFeatures(envelope.payload);
      ctx.sessionTransport.bind(ctx.socket, features);
      ctx.roster.serverTakesFolders = features.workspaceFolders === true;
      if (ctx.roster.serverTakesFolders) ctx.roster.checkFolders();
      serveResources(ctx, features.resources === true);
      // Timer-driven background turns arrive while no Foundry turn is
      // active; route their events over this socket as ordinary
      // session_event envelopes the server persists and broadcasts.
      ctx.routeOutOfBandEvents();
      // The turns Claude runs on its own, to a server that follows them;
      // those running now are told again (the server forgets them when
      // the device goes).
      setSessionTurnSink(
        features.sessionTurns
          ? (sessionId, running) =>
              ctx.sessionTransport.send(daemonMessageTypes.sessionTurn, {
                sessionId,
                running,
              } satisfies SessionTurnPayload)
          : undefined,
      );
      ctx.announceAdditionalIssueCapacity();
      if (ctx.once && ctx.idleTimeoutMs > 0) {
        ctx.state.idleTimer = setTimeout(
          () => ctx.finish("exit"),
          ctx.idleTimeoutMs,
        );
      }
    })
    .on(daemonMessageTypes.sessionTimers, (envelope, ctx) => {
      // Timers of a session the server knows: kept here unless this
      // worker keeps or runs that session's own.
      if (!ctx.once) sessionTimers.adopt([envelope.payload as SessionTimers]);
    });
}
