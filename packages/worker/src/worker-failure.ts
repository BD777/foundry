/** One reporting boundary for terminal Worker failures, including startup recovery. */
import {
  daemonMessageTypes,
  diagnoseWorkerFailure,
} from "@bd777/foundry-protocol";
import { sessionEvent } from "./session-helpers.js";
import { redactTranscriptText } from "./secret-redaction.js";
import type { ReliableSessionTransport } from "./transport.js";

export function reportWorkerFailure(
  transport: Pick<ReliableSessionTransport, "send">,
  session: { id: string; input?: { id: string } },
  error: unknown,
): void {
  const message = redactTranscriptText(
    error instanceof Error ? error.message : String(error),
  );
  const failure = {
    ...diagnoseWorkerFailure(message),
    inputId: session.input?.id,
  };
  transport.send(daemonMessageTypes.sessionEvent, {
    event: sessionEvent(
      session.id,
      "Session failed",
      message,
      "error",
      undefined,
      {
        workerFailure: failure,
      },
    ),
  });
  // Preserve the existing error contract for older servers and clients.
  transport.send(daemonMessageTypes.sessionCompleted, {
    sessionId: session.id,
    inputId: session.input?.id,
    error: message,
  });
}
