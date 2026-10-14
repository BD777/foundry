import {
  daemonMessageTypes,
  type ConnectorRequestPayload,
} from "@bd777/foundry-protocol";
import { handleConnectorRequest } from "../../connectors/index.js";
import { reply, type DaemonDispatch } from "../dispatch.js";

/** Device-held connectors: status, install, sign-in and sign-out on request. */
export function registerConnectorHandlers(dispatch: DaemonDispatch): void {
  dispatch.on(daemonMessageTypes.connectorRequest, (envelope, ctx) =>
    reply(ctx, envelope, daemonMessageTypes.connectorReply, () =>
      handleConnectorRequest(envelope.payload as ConnectorRequestPayload),
    ),
  );
}
