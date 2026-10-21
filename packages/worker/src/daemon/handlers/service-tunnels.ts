import {
  daemonMessageTypes,
  type ServiceTunnelOpenPayload,
} from "@bd777/foundry-protocol";
import type WebSocket from "ws";
import { daemonRequestHeaders } from "../../server-http.js";
import { openServiceTunnel } from "../../service-tunnels.js";
import type { DaemonDispatch } from "../dispatch.js";

// One close listener per control connection, even at the concurrency limit.
const active = new WeakMap<WebSocket, Set<() => void>>();
export function registerServiceTunnelHandlers(dispatch: DaemonDispatch): void {
  dispatch.on(daemonMessageTypes.serviceTunnelOpen, (envelope, ctx) => {
    const request = envelope.payload as ServiceTunnelOpenPayload;
    ctx.roster.folderFor(request.workspaceId);
    let streams = active.get(ctx.socket);
    if (!streams) {
      streams = new Set();
      active.set(ctx.socket, streams);
      ctx.socket.once("close", () => {
        for (const close of streams!) close();
        streams!.clear();
      });
    }
    if (ctx.socket.readyState !== 1 || streams.size >= 32) return;
    const close = openServiceTunnel({
      serverURL: ctx.serverURL,
      headers: daemonRequestHeaders(false),
      request,
      onClose: () => streams!.delete(close),
    });
    streams.add(close);
  });
}
