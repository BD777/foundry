import { ControlOutcomeUnknownError } from "../agent-runtime/control-error.js";
import { randomUUID } from "node:crypto";
import {
  processLabels,
  type AgentSession,
  type ChatAttachment,
} from "@bd777/foundry-protocol";
import { ClaudeAgentTurnError } from "../sdk-messages.js";
import { redactSecrets } from "../secret-redaction.js";
import {
  AgentSessionCanceledError,
  registerActiveSessionCancelTarget,
  registerActiveSessionSteerTarget,
  type SessionCancelOutcome,
} from "../session-control.js";
import type { SessionTurnFiles } from "../session-files.js";
import { userMessageText } from "../session-prompt.js";
import type {
  ActiveClaudeRuntime,
  ActiveClaudeTurn,
  AgentSessionRunResult,
} from "../session-state.js";
import { ClaudeRequestUsageTracker } from "../turn-usage.js";
import {
  ClaudeTurnLiveness,
  livenessDuration,
  turnLivenessNoticeText,
  turnLivenessSettings,
  type TurnLivenessFailure,
  type TurnLivenessNotice,
} from "../watchdog.js";
import {
  claudeRuntimeHasLiveWork,
  closeActiveClaudeRuntime,
} from "./active-runtimes.js";
import {
  claudeTurnOperationBounds,
  type ClaudeTurnRun,
} from "./claude-launch.js";

/**
 * Why a start-up or ceiling bound failed a turn. Quiet never does: see
 * watchdog.ts.
 */
export function claudeTurnLivenessError(
  failure: TurnLivenessFailure,
  stderrTail = "",
): Error {
  const tail = stderrTail.trim()
    ? ` Claude Code's last output: ${redactSecrets(stderrTail.trim()).slice(-1200)}`
    : "";
  if (failure.kind === "ceiling")
    return new ClaudeAgentTurnError(
      "turn_ceiling",
      `The turn ran for ${livenessDuration(failure.elapsedMs)}, Foundry's ceiling for one turn (FOUNDRY_TURN_MAX_DURATION_MS), and was stopped.`,
    );
  if (failure.phase === "spawn")
    return new ClaudeAgentTurnError(
      "startup_timeout",
      `Claude Code did not start: its process sent nothing within ${livenessDuration(failure.waitedMs)} of launch (phase: starting the process).${tail}`,
    );
  return new ClaudeAgentTurnError(
    "startup_timeout",
    `Claude Code started but never reached the model within ${livenessDuration(failure.waitedMs)} of launch (phase: sign-in or first response).${tail}`,
  );
}

/** A liveness notice, on the turn's transcript. */
export function claudeTurnLivenessNotice(
  turn: Pick<ActiveClaudeTurn, "emit">,
  notice: TurnLivenessNotice,
): void {
  void turn.emit(
    processLabels.notice,
    turnLivenessNoticeText(notice),
    "warning",
  );
}

/**
 * Sessions judged on their answer keep their turn until background work
 * settles: an Issue's execution is verified on it (and a sandboxed run's
 * process ends with the turn), and an agent that created a session waits for
 * its answer. A person's chat ends its turn with Claude's answer.
 */
export function waitsForBackgroundWork(session: AgentSession): boolean {
  return (
    Boolean(session.issueId?.trim()) ||
    Boolean(session.role) ||
    (session.source !== undefined && session.source !== "chat")
  );
}

/**
 * Lets the session's steer and stop reach this turn while it is the one its
 * runtime serves. Returns the unregistration.
 */
export function registerClaudeTurnControls(
  run: ClaudeTurnRun,
  runtime: ActiveClaudeRuntime,
): () => void {
  const unregisterSteer = registerActiveSessionSteerTarget(run.session.id, {
    provider: "claude",
    steer: (message, attachments = [], steerId, sentBySessionId) =>
      steerClaudeTurn(
        run,
        runtime,
        message,
        attachments,
        steerId,
        sentBySessionId,
      ),
  });
  const unregisterCancel = registerActiveSessionCancelTarget(run.session.id, {
    provider: "claude",
    inputId: run.session.input?.id,
    cancel: () => cancelClaudeTurn(run, runtime),
  });
  return () => {
    unregisterSteer();
    unregisterCancel();
  };
}

async function steerClaudeTurn(
  run: ClaudeTurnRun,
  runtime: ActiveClaudeRuntime,
  message: string,
  attachments: ChatAttachment[],
  steerId?: string,
  sentBySessionId?: string,
): Promise<void> {
  if (runtime.pending?.resultPath !== run.resultPath) {
    throw new Error(
      "Claude is not accepting steer input for this active turn.",
    );
  }
  const text = message.trim();
  if (run.plan) run.plan.validatePrompt(text);
  if (!text && attachments.length === 0) {
    throw new Error("Steer message is required.");
  }
  runtime.input.push({
    message: {
      role: "user",
      content: userMessageText(text, attachments, sentBySessionId),
    },
    parent_tool_use_id: null,
    priority: "next",
    type: "user",
  });
  try {
    await run.emit(
      "Steered into active turn",
      text,
      "info",
      undefined,
      attachments.length > 0
        ? {
            id: `steer_${randomUUID()}`,
            kind: "user",
            text,
            attachments,
          }
        : undefined,
      // Named like a sent message's input event: the server then knows the
      // message is in this session and never sends it again as an input of
      // its own.
      steerId ? `evt_${steerId}` : undefined,
    );
  } catch {
    throw new ControlOutcomeUnknownError(
      "Native input was accepted, but its receipt could not be persisted. Reconcile before retrying.",
    );
  }
}

async function cancelClaudeTurn(
  run: ClaudeTurnRun,
  runtime: ActiveClaudeRuntime,
): Promise<SessionCancelOutcome> {
  const turn = runtime.pending;
  if (!turn || turn.resultPath !== run.resultPath) {
    throw new Error(
      "Claude is not accepting cancellation for this active turn.",
    );
  }
  const answered = turn.deliveredResponse !== undefined;
  closeActiveClaudeRuntime(runtime, new AgentSessionCanceledError());
  return { answered };
}

/**
 * The turn its runtime serves from now on: how it settles, what it records
 * and how its liveness is bounded. startsProcess: the process starts for
 * this turn, so it has a start-up to bound.
 */
export function openClaudeTurn(
  run: ClaudeTurnRun,
  runtime: ActiveClaudeRuntime,
  files: SessionTurnFiles,
  startsProcess: boolean,
  settle: {
    resolve: (result: AgentSessionRunResult) => void;
    reject: (error: unknown) => void;
  },
): ActiveClaudeTurn {
  const livenessSettings = turnLivenessSettings();
  const minutes = run.session.input?.executionBudget?.timeoutMinutes;
  if (minutes && minutes > 0) {
    const bound = Math.min(minutes, 240) * 60_000;
    livenessSettings.ceilingMs =
      livenessSettings.ceilingMs > 0
        ? Math.min(livenessSettings.ceilingMs, bound)
        : bound;
  }
  const operationBounds = claudeTurnOperationBounds(run);
  const turn: ActiveClaudeTurn = {
    emit: run.emit,
    finalResult: "",
    messagesPath: run.messagesPath,
    nativeSessionId: runtime.nativeSessionId || run.requestedNativeSessionId,
    partialResult: "",
    openTaskIds: new Set<string>(),
    waitForBackgroundTasks: waitsForBackgroundWork(run.session),
    ...(run.session.input?.id ? { commandId: run.session.input.id } : {}),
    behindContinuation: Boolean(runtime.continuation),
    requestUsage: new ClaudeRequestUsageTracker(),
    reject: settle.reject,
    reportNativeSessionId: run.reportNativeSessionId,
    resolve: settle.resolve,
    resultPath: run.resultPath,
    startedAt: run.startedAt,
    files,
    liveness: new ClaudeTurnLiveness(
      {
        ...livenessSettings,
        ...(minutes && minutes > 0
          ? {
              checkIntervalMs: Math.max(
                50,
                Math.min(1000, (minutes * 60_000) / 4),
              ),
            }
          : {}),
        ...(startsProcess
          ? {
              firstResponseTimeoutMs: Math.min(
                operationBounds.apiTimeoutMs + livenessSettings.graceMs,
                minutes && minutes > 0
                  ? Math.min(minutes, 240) * 60_000
                  : Number.POSITIVE_INFINITY,
              ),
            }
          : { startupTimeoutMs: undefined }),
        backgroundBusy: () =>
          turn.openTaskIds.size > 0 || claudeRuntimeHasLiveWork(runtime),
        onNotice: (notice) => {
          if (runtime.pending === turn) claudeTurnLivenessNotice(turn, notice);
        },
        onFailure: (failure) => {
          if (runtime.pending !== turn) return;
          closeActiveClaudeRuntime(
            runtime,
            claudeTurnLivenessError(failure, runtime.stderrTail),
          );
        },
      },
      operationBounds,
    ),
  };
  return turn;
}
