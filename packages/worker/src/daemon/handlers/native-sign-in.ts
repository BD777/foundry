import {
  daemonMessageTypes,
  type NativeSignInReplyPayload,
  type NativeSignInRequestPayload,
} from "@bd777/foundry-protocol";
import { nativeSignIn } from "../../harness/native/native-sign-in.js";
import { reply, type DaemonDispatch } from "../dispatch.js";

/**
 * The official subscriptions' sign-in for the device's owner. Once a
 * sign-in completes, or after a sign-out, the answer carries the device's
 * fresh registration so its local login shows at once.
 */
export function registerNativeSignInHandlers(dispatch: DaemonDispatch): void {
  dispatch.on(daemonMessageTypes.nativeSignIn, (envelope, ctx) =>
    reply(
      ctx,
      envelope,
      daemonMessageTypes.nativeSignInReply,
      async (): Promise<NativeSignInReplyPayload> => {
        const request = envelope.payload as NativeSignInRequestPayload;
        const signIn = await nativeSignIn(request);
        const changed =
          request.action === "sign_out" || signIn?.status === "complete";
        return {
          ...(signIn ? { signIn } : {}),
          ...(changed
            ? {
                registration: ctx.roster.currentRegistration() as NonNullable<
                  NativeSignInReplyPayload["registration"]
                >,
              }
            : {}),
        };
      },
    ),
  );
}
