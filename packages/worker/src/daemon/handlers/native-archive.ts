import {
  daemonMessageTypes,
  type NativeArchivePayload,
} from "@bd777/foundry-protocol";
import { applyNativeArchive } from "../../native-archive.js";
import { reply, type DaemonDispatch } from "../dispatch.js";

export function registerNativeArchiveHandlers(dispatch: DaemonDispatch): void {
  dispatch.on(daemonMessageTypes.nativeArchive, (envelope, ctx) =>
    reply(ctx, envelope, daemonMessageTypes.nativeArchiveResult, async () => {
      const payload = envelope.payload as NativeArchivePayload;
      const items = payload?.items;
      if (!Array.isArray(items) || items.length > 1000)
        throw new Error("Invalid native archive items");
      const results = [];
      for (const item of items)
        results.push(
          await applyNativeArchive(
            item,
            Boolean(
              item.sessionId &&
              ctx.sessionExecutions.activeSessionIds().includes(item.sessionId),
            ),
            payload.dryRun === true,
          ),
        );
      return { items: results };
    }),
  );
}
