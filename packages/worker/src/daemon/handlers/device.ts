import {
  daemonMessageTypes,
  type DeviceRepairAction,
  type DeviceSharingPayload,
  type RunRepairPayload,
} from "@bd777/foundry-protocol";
import WebSocket from "ws";
import { runDiagnostics, runRepair } from "../../diagnostics.js";
import { readWorkerUpdateStatus } from "../../self-update-status.js";
import { trySendWebSocket } from "../../transport.js";
import {
  startSelfUpdate,
  watchSelfUpdateFailure,
} from "../../worker-self-update.js";
import { currentSocket } from "../context.js";
import {
  executionHostClient,
  RunnerTurnsChangedError,
} from "../../execution-host/client.js";
import { reply, type DaemonDispatch } from "../dispatch.js";
import { errorMessage } from "../../utils.js";
import { setSystemAccountSharing } from "../../system-account-sharing.js";

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
    .on(daemonMessageTypes.deviceSharing, (envelope) => {
      setSystemAccountSharing(
        envelope.payload as Partial<DeviceSharingPayload> | undefined,
      );
    })
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
