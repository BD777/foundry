import {
  daemonMessageTypes,
  type DeviceRepairAction,
  type RunRepairPayload,
} from "@bd777/foundry-protocol";
import WebSocket from "ws";
import { runDiagnostics, runRepair } from "../diagnostics.js";
import { readWorkerUpdateStatus } from "../../install/self-update-status.js";
import { trySendWebSocket } from "../../transport/transport.js";
import {
  startSelfUpdate,
  watchSelfUpdateFailure,
} from "../../install/worker-self-update.js";
import { currentSocket } from "../context.js";
import { RunnerTurnsChangedError } from "../../execution-host/client.js";
import { executionHostClient } from "../../execution-host/fleet.js";
import { reply, type DaemonDispatch } from "../dispatch.js";
import { errorMessage } from "../../platform/utils.js";
import {
  clearWorkerProxy,
  describeProxy,
  readWorkerProxy,
  setWorkerProxy,
} from "../../platform/server-link/server-proxy.js";

/**
 * The owner's choice from the device page: stop using the saved proxy, or
 * use another one. The proxy watcher then reconnects the control socket on
 * the new route, after this answer has gone out. Credentials never come back.
 */
export function applyWorkerProxySetting(payload: unknown): {
  proxy?: string;
} {
  const { url, clear } = (payload ?? {}) as { url?: unknown; clear?: unknown };
  if (clear === true && url === undefined) {
    clearWorkerProxy();
    return {};
  }
  if (typeof url !== "string" || clear !== undefined)
    throw new Error("Name a proxy address, or ask to stop using the proxy.");
  // A saved no-proxy list stays with the new address.
  let noProxy: string | undefined;
  try {
    noProxy = readWorkerProxy()?.noProxy;
  } catch {
    noProxy = undefined;
  }
  setWorkerProxy(url.trim(), noProxy);
  return { proxy: describeProxy(url.trim()) };
}

/** Round trip of one ping over a control socket, in milliseconds. */
function socketRoundTrip(socket: WebSocket): Promise<number> {
  return new Promise((resolvePing, rejectPing) => {
    if (socket.readyState !== WebSocket.OPEN) {
      rejectPing(new Error("the control socket is not open"));
      return;
    }
    const started = Date.now();
    const onPong = () => {
      clearTimeout(timer);
      resolvePing(Date.now() - started);
    };
    const timer = setTimeout(() => {
      socket.off("pong", onPong);
      rejectPing(new Error("no pong from the server in 10s"));
    }, 10_000);
    socket.once("pong", onPong);
    socket.ping();
  });
}

/** The worker itself: its updates, diagnostics and repairs. */
export function registerDeviceHandlers(dispatch: DaemonDispatch): void {
  dispatch
    .on(daemonMessageTypes.readWorkerUpdateStatus, (envelope, ctx) => {
      trySendWebSocket(
        ctx.socket,
        daemonMessageTypes.workerUpdateStatus,
        readWorkerUpdateStatus(),
        envelope.id,
      );
    })
    .on(daemonMessageTypes.updateWorker, (envelope, ctx) => {
      try {
        const started = startSelfUpdate(ctx.serverURL);
        trySendWebSocket(
          ctx.socket,
          daemonMessageTypes.workerUpdateStarted,
          started,
          envelope.id,
        );
        // A failure goes to the server as soon as it is written, on
        // whichever connection is open then.
        watchSelfUpdateFailure((status) => {
          const socket = currentSocket();
          if (socket)
            trySendWebSocket(
              socket,
              daemonMessageTypes.workerUpdateStatus,
              status,
            );
        });
      } catch (error) {
        trySendWebSocket(
          ctx.socket,
          daemonMessageTypes.workerUpdateStarted,
          { error: errorMessage(error) },
          envelope.id,
        );
      }
    })
    .on(daemonMessageTypes.readExecutionRunner, (envelope, ctx) =>
      reply(ctx, envelope, daemonMessageTypes.executionRunnerRead, async () => {
        const host = executionHostClient();
        if (!host) return { turns: [] };
        await host.refresh();
        return host.runnerDetail();
      }),
    )
    .on(daemonMessageTypes.switchExecutionRunner, (envelope, ctx) => {
      const payload = envelope.payload as
        { turns?: Array<{ sessionId?: string; inputId?: string }> } | undefined;
      const turns = (payload?.turns ?? []).flatMap((turn) =>
        typeof turn?.sessionId === "string"
          ? [{ sessionId: turn.sessionId, inputId: turn.inputId || undefined }]
          : [],
      );
      return reply(
        ctx,
        envelope,
        daemonMessageTypes.executionRunnerSwitched,
        async () => {
          const host = executionHostClient();
          if (!host) return { switched: true };
          return host.switchNow(turns);
        },
        (error, cause) => ({
          error,
          changed: cause instanceof RunnerTurnsChangedError,
        }),
      );
    })
    .on(daemonMessageTypes.setWorkerProxy, (envelope, ctx) =>
      reply(ctx, envelope, daemonMessageTypes.workerProxySet, () =>
        applyWorkerProxySetting(envelope.payload),
      ),
    )
    .on(daemonMessageTypes.runDiagnostics, (envelope, ctx) =>
      reply(ctx, envelope, daemonMessageTypes.diagnosticsReady, async () => ({
        report: await runDiagnostics({
          serverURL: ctx.serverURL,
          socketRoundTrip: () => socketRoundTrip(ctx.socket),
        }),
      })),
    )
    .on(daemonMessageTypes.runRepair, (envelope, ctx) => {
      const payload = envelope.payload as RunRepairPayload | undefined;
      return reply(ctx, envelope, daemonMessageTypes.repairDone, () => ({
        result: runRepair(
          payload?.action as DeviceRepairAction,
          ctx.checkProvidersAndReport,
        ),
      }));
    });
}
