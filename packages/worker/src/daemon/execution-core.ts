/**
 * One path for an input the server dispatches, whether the execution host
 * runs it (execution-host/server.ts, with durable claims) or the worker
 * itself (handlers/sessions.ts, without a host): accept it once, report a
 * result recorded earlier again instead of running it twice, schedule it
 * under its key, run it, and settle it: its failure reported, its claim
 * freed, and the server asked for further Issues.
 */
import {
  daemonMessageTypes,
  type AgentSession,
  type RunSessionPayload,
} from "@bd777/foundry-protocol";
import { ExecutionStore } from "../candidate-store/execution-storage.js";
import { recoveredClarificationCompletion } from "../issue/issue-clarification.js";
import { issueSessionCompletion } from "../issue/issue-execution.js";
import { queuePreview, runIssuePreview } from "../issue/issue-preview.js";
import {
  recordedIssueCompletion,
  recoveredIssueCompletion,
} from "../issue/issue-recovery.js";
import { noteSessionInput } from "../session/session-control.js";
import { readAgentSessionCompletionMarker } from "../session/session-helpers.js";
import { isVerificationSession } from "../session/session-roles.js";
import { slotWaitNotice } from "../session/slot-wait.js";
import {
  sessionAdmissionClass,
  type ConcurrentTaskScheduler,
} from "../platform/task-scheduler.js";
import type { ReliableSessionTransport } from "../transport/transport.js";
import { verificationDirectory } from "../session/verification-session.js";
import { reportWorkerFailure } from "../session/worker-failure.js";
import { runAgentSession } from "./session-run.js";

/** Who holds an input: an input is claimed once and never runs twice. */
export interface ExecutionClaims {
  /** False when the input was claimed before. */
  claim(sessionId: string, dispatchId: string, inputId?: string): boolean;
  complete(sessionId: string, dispatchId: string): void;
}

export type RunInput = (
  serverURL: string,
  workspacePath: string,
  transport: ReliableSessionTransport,
  payload: RunSessionPayload,
) => Promise<void>;

export interface ExecutionCoreOptions {
  serverURL: string;
  transport: ReliableSessionTransport;
  scheduler: ConcurrentTaskScheduler;
  claims: ExecutionClaims;
  /** Whether a settled Issue session asks the server for further Issues. */
  asksForIssues: boolean;
  /** After an input settled (a --once worker exits). */
  settled?: () => void;
  /** Settling itself failed: the claim could not be recorded. */
  failed: (error: unknown) => void;
  /** Runs one input; tests replace it. */
  run?: RunInput;
  /** Persists the accepted claim before the native input starts. */
  beforeRun?: () => Promise<void>;
}

/**
 * Everything working in one Issue's candidate (its execution, the sessions
 * an Issue's agent starts, verifiers, its preview) and its clarification
 * runs one at a time, whichever runs first; other sessions one input at a
 * time each.
 */
export function issueSchedulingKey(issueId: string): string {
  return `issue:${issueId}`;
}

export function sessionSchedulingKey(session: AgentSession): string {
  return session.issueId
    ? issueSchedulingKey(session.issueId)
    : ["session", session.workspaceId, session.provider, session.id].join(":");
}

/** What finds an input's recorded result: what recover_session carries. */
export type RecordedSession = Pick<
  AgentSession,
  "id" | "workspaceId" | "issueId" | "role" | "source" | "dispatchId"
> & { input?: { id: string } };

/** The native execution identity: stable input until an automatic retry. */
export function sessionDispatchId(
  session: Pick<AgentSession, "dispatchId"> & {
    input?: { id: string };
  },
): string {
  return session.dispatchId?.trim() || session.input?.id || "";
}

/** The report this device recorded for the input, if it already finished here. */
export function recordedCompletion(
  session: RecordedSession,
  workspacePath: () => string,
): Record<string, unknown> | undefined {
  const inputId = session.input?.id || undefined;
  const dispatchId = sessionDispatchId(session) || undefined;
  if (session.role === "issue_execution") {
    const recorded = recordedIssueCompletion(
      session.workspaceId,
      session.issueId ?? "",
      dispatchId || session.id,
    );
    return (
      recorded && {
        ...issueSessionCompletion(session.id, inputId, recorded),
        ...(session.dispatchId ? { dispatchId: session.dispatchId } : {}),
      }
    );
  }
  if (session.role === "issue_clarification") {
    const report = recoveredClarificationCompletion(
      session.workspaceId,
      session.issueId ?? "",
      session.id,
      inputId ?? "",
    );
    return report.clarificationResult
      ? {
          ...report,
          ...(session.dispatchId ? { dispatchId: session.dispatchId } : {}),
        }
      : undefined;
  }
  // The stateRoot session-execution.ts gives the session: an Issue's other
  // sessions keep their records beside its candidate, a verifier in its own
  // directory.
  const stateRoot = session.issueId
    ? new ExecutionStore().environment(session.workspaceId, session.issueId)
        ?.directory
    : isVerificationSession(session)
      ? verificationDirectory(session.workspaceId, session.id)
      : workspacePath();
  const marker = stateRoot
    ? readAgentSessionCompletionMarker(stateRoot, session.id, dispatchId ?? "")
    : undefined;
  return (
    marker && {
      sessionId: session.id,
      inputId,
      ...(session.dispatchId ? { dispatchId: session.dispatchId } : {}),
      nativeSessionId: marker.nativeSessionId,
      response: marker.response,
    }
  );
}

/**
 * The report for an input no process here runs any more (recover_session):
 * its recorded result, or that the result was lost.
 */
export function recoveredCompletion(
  session: RecordedSession,
  workspacePath: () => string,
): Record<string, unknown> {
  const recorded = recordedCompletion(session, workspacePath);
  if (recorded) return recorded;
  const inputId = session.input?.id || undefined;
  if (session.role === "issue_execution") {
    const stopped = recoveredIssueCompletion(
      session.workspaceId,
      session.issueId ?? "",
      session.dispatchId?.trim() || session.id,
    );
    return stopped
      ? {
          ...issueSessionCompletion(session.id, inputId, stopped),
          ...(session.dispatchId ? { dispatchId: session.dispatchId } : {}),
        }
      : {
          sessionId: session.id,
          inputId,
          error:
            "The worker restarted before this execution started; retry to run it again.",
        };
  }
  if (session.role === "issue_clarification")
    return recoveredClarificationCompletion(
      session.workspaceId,
      session.issueId ?? "",
      session.id,
      inputId ?? "",
    );
  return {
    sessionId: session.id,
    inputId,
    error:
      "The worker stopped while this message was running, so its result was lost. Send it again to continue.",
  };
}

export class ExecutionCore {
  private pending = 0;

  constructor(private readonly options: ExecutionCoreOptions) {}

  /** Inputs and previews accepted and not yet finished. */
  scheduled(): number {
    return this.pending;
  }

  /**
   * Takes an input; false when it was taken before. `workspacePath` is read
   * when the input runs, so a folder gone by then fails it.
   */
  accept(payload: RunSessionPayload, workspacePath: () => string): boolean {
    const { claims, scheduler, transport } = this.options;
    const session = payload.session;
    const inputId = session.input?.id ?? "";
    const dispatchId = sessionDispatchId(session);
    if (!claims.claim(session.id, dispatchId, inputId)) return false;
    // A steer of the same message arriving late must not add it to this
    // input's own turn.
    if (inputId) noteSessionInput(session.id, inputId);
    // An input that already finished here (its report lost with an earlier
    // process) is reported again rather than run twice; an unreadable
    // record runs it.
    let recorded: Record<string, unknown> | undefined;
    try {
      recorded = recordedCompletion(session, workspacePath);
    } catch {
      recorded = undefined;
    }
    if (recorded) {
      transport.send(daemonMessageTypes.sessionCompleted, recorded);
      this.settle(session, dispatchId);
      return true;
    }
    const slotWait = slotWaitNotice(transport, session);
    this.track(
      scheduler.schedule(
        sessionSchedulingKey(session),
        async () => {
          await this.options.beforeRun?.();
          slotWait.started(scheduler.load());
          console.log(
            payload.issue && session.role === "issue_execution"
              ? `Running ${payload.issue.shortId} (${payload.issue.title}) as session ${session.id}`
              : `Running ${session.provider} session ${session.id}`,
          );
          try {
            await (this.options.run ?? runAgentSession)(
              this.options.serverURL,
              workspacePath(),
              transport,
              payload,
            );
          } catch (error) {
            reportWorkerFailure(transport, session, error);
          } finally {
            this.settle(session, dispatchId);
          }
        },
        slotWait.onWait,
        {
          admissionClass: sessionAdmissionClass(session),
          runtime: session.provider,
          sessionId: session.id,
          workspaceId: session.workspaceId,
        },
      ),
      this.options.failed,
    );
    return true;
  }

  /** Starts an Issue's preview once nothing else runs in its candidate. */
  preview(request: {
    workspaceId: string;
    issueId: string;
    revision: number;
  }): {
    status: "preview_queued";
    revision: number;
  } {
    queuePreview(request.issueId);
    this.track(
      this.options.scheduler.schedule(issueSchedulingKey(request.issueId), () =>
        runIssuePreview(request.workspaceId, request.issueId),
      ),
      (error) => console.error(error),
    );
    return { status: "preview_queued", revision: request.revision };
  }

  private settle(session: AgentSession, inputId: string): void {
    this.options.claims.complete(session.id, inputId);
    if (session.issueId && this.options.asksForIssues)
      this.options.transport.send(daemonMessageTypes.readyForIssue, {});
    this.options.settled?.();
  }

  private track(task: Promise<unknown>, failed: (error: unknown) => void) {
    this.pending++;
    void task
      .finally(() => {
        this.pending--;
      })
      .catch(failed);
  }
}
