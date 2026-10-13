import type { ProtocolEnvelope } from "@bd777/foundry-protocol";
import { trySendWebSocket } from "../transport.js";
import type { DaemonContext } from "./context.js";
import { errorMessage } from "../utils.js";

export type DaemonHandler = (
  envelope: ProtocolEnvelope,
  ctx: DaemonContext,
) => void | Promise<void>;

/** The daemon's answer to each message type the server sends it. */
export class DaemonDispatch {
  private readonly handlers = new Map<string, DaemonHandler>();

  on(type: string, handler: DaemonHandler): this {
    this.handlers.set(type, handler);
    return this;
  }

  types(): string[] {
    return [...this.handlers.keys()];
  }

  /** Messages of a type nothing handles are ignored. */
  async dispatch(
    envelope: ProtocolEnvelope,
    ctx: DaemonContext,
  ): Promise<void> {
    await this.handlers.get(envelope.type)?.(envelope, ctx);
  }
}

/**
 * Answers a request with what `run` returns, or with `onError`'s reply
 * (`{ error }` unless given) when it throws.
 */
export async function reply(
  ctx: DaemonContext,
  envelope: ProtocolEnvelope,
  type: string,
  run: () => unknown,
  onError: (message: string, error: unknown) => unknown = (message) => ({
    error: message,
  }),
): Promise<void> {
  let payload: unknown;
  try {
    payload = await run();
  } catch (error) {
    payload = onError(errorMessage(error), error);
  }
  trySendWebSocket(ctx.socket, type, payload, envelope.id);
}
