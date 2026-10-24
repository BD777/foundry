import {
  diagnoseWorkerFailure,
  isWorkerDiskObservation,
  isWorkerFailure,
  sessionInputEventLabel,
  workerFailurePolicies,
  type AgentSession,
  type DeviceProjection,
} from "@bd777/foundry-protocol";
import { i18n } from "../../i18n";
import type { ChatViewMessage } from "./chat-types";

/** Presentation only. Classification and recovery policy are shared with Worker. */
export function agentSessionFailureMessage(
  session: AgentSession,
  error: string,
  devices: readonly Pick<DeviceProjection, "id" | "label">[] = [],
): Pick<
  ChatViewMessage,
  "text" | "title" | "recoverable" | "failureDiagnostic"
> {
  const events = session.events ?? [];
  const boundary = events
    .map((event) => event.label)
    .lastIndexOf(sessionInputEventLabel);
  const start = Date.parse(session.input?.at ?? session.startedAt ?? "");
  const end = Date.parse(session.completedAt ?? "");
  const current = events.slice(boundary + 1).filter((event) => {
    const at = Date.parse(event.at);
    return (
      (Number.isFinite(start) ? at >= start : boundary >= 0) &&
      (!Number.isFinite(end) || at <= end)
    );
  });
  const reported = [...current]
    .reverse()
    .find(
      (event) =>
        event.level === "error" &&
        event.detail.trim() === error &&
        isWorkerFailure(event.metadata?.workerFailure) &&
        Boolean(session.input?.id) &&
        event.metadata?.workerFailure?.inputId === session.input?.id,
    )?.metadata?.workerFailure;
  const failure = reported ?? diagnoseWorkerFailure(error);
  if (failure.code === "turn_limit") {
    const count = error.match(/maximum number of turns\s*\((\d+)\)/i)?.[1];
    const turns = count
      ? i18n.t("chat:failure.turns", { count: Number(count) })
      : i18n.t("chat:failure.allowedTurns");
    return {
      recoverable: Boolean(session.nativeSessionId),
      text: i18n.t(
        session.nativeSessionId
          ? "chat:failure.maxTurnsResumable"
          : "chat:failure.maxTurnsLost",
        { turns },
      ),
      title: i18n.t("chat:failure.maxTurnsTitle"),
    };
  }
  // An unrecognized error is still the most specific thing known: show it
  // as the message, not behind a generic "cause not identified".
  if (failure.code === "unknown") {
    return {
      recoverable: false,
      text: error,
      title: i18n.t("chat:failure.title"),
      failureDiagnostic: {
        guidance: i18n.t("chat:failure.recovery.inspect_details"),
      },
    };
  }
  const policy = workerFailurePolicies[failure.code];
  const observedDiskFull =
    failure.code === "execution_host_stopped" &&
    current.some(isWorkerDiskObservation);
  const device = devices.find(
    (device) => device.id === session.deviceId,
  )?.label;
  return {
    recoverable: false,
    title: i18n.t(`chat:failure.worker.${failure.code}.title`),
    text: i18n.t(`chat:failure.worker.${failure.code}.summary`),
    failureDiagnostic: {
      location:
        policy.location === "device" && device
          ? i18n.t("chat:failure.location.namedDevice", { device })
          : i18n.t(`chat:failure.location.${policy.location}`),
      guidance: i18n.t(
        `chat:failure.recovery.${observedDiskFull ? "free_space" : policy.recovery}`,
      ),
      observation: observedDiskFull
        ? i18n.t("chat:failure.diskObservation")
        : undefined,
      details: error,
    },
  };
}
