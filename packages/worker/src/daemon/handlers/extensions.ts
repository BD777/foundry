import {
  daemonMessageTypes,
  type ExtensionRequestPayload,
} from "@bd777/foundry-protocol";
import { handleExtensionRequest } from "../../connectors/index.js";
import { reply, type DaemonDispatch } from "../dispatch.js";

/**
 * Connector extensions, for the device's owner: install or update one from
 * its git folder, or remove one; the device reports its connectors at once.
 */
export function registerExtensionHandlers(dispatch: DaemonDispatch): void {
  dispatch.on(daemonMessageTypes.extensionRequest, (envelope, ctx) =>
    reply(ctx, envelope, daemonMessageTypes.extensionReply, async () => {
      const answer = await handleExtensionRequest(
        envelope.payload as ExtensionRequestPayload,
      );
      if (!answer.error) ctx.roster.reportDevice();
      return answer;
    }),
  );
}
