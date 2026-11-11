/** One reporting boundary for terminal Worker failures, including startup recovery. */
import {
  daemonMessageTypes,
  diagnoseWorkerFailure,
} from "@bd777/foundry-protocol";
import { sessionEvent } from "./session-helpers.js";
import { redactTranscriptText } from "../platform/secret-redaction.js";
import type { ReliableSessionTransport } from "../transport/transport.js";
import { errorMessage } from "../platform/utils.js";

export function reportWorkerFailure(
  transport: Pick<ReliableSessionTransport, "send">,
  session: { id: string; dispatchId?: string; input?: { id: string } },
  error: unknown,
  /** What the session's role adds to the report (an Issue's result). */
  report?: Record<string, unknown>,
): void {
  const message = redactTranscriptText(errorMessage(error));
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
    ...(session.dispatchId ? { dispatchId: session.dispatchId } : {}),
    error: message,
    ...report,
  });
}
