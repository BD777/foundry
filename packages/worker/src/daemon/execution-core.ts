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
import { recoveredClarificationCompletion } from "../issue/issue-clarification.js";
import { issueSessionCompletion } from "../issue/issue-execution.js";
import { queuePreview, runIssuePreview } from "../issue/issue-preview.js";
import { recordedIssueCompletion } from "../issue/issue-recovery.js";
import { noteSessionInput } from "../session/session-control.js";
import { readAgentSessionCompletionMarker } from "../session/session-helpers.js";
import { isVerificationSession } from "../session/session-roles.js";
import { slotWaitNotice } from "../session/slot-wait.js";
import type { ConcurrentTaskScheduler } from "../platform/task-scheduler.js";
import type { ReliableSessionTransport } from "../transport/transport.js";
import { verificationDirectory } from "../session/verification-session.js";
import { reportWorkerFailure } from "../session/worker-failure.js";
import { runDispatchedIssue } from "./issue-run.js";
import { runAgentSession } from "./session-run.js";

/** Who holds an input: an input is claimed once and never runs twice. */
export interface ExecutionClaims {
  /** False when the input was claimed before. */
  claim(sessionId: string, inputId: string): boolean;
  complete(sessionId: string, inputId: string): void;
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

/** The report this device recorded for the input, if it already finished here. */
export function recordedCompletion(
  session: AgentSession,
  workspacePath: () => string,
): Record<string, unknown> | undefined {
  const inputId = session.input?.id || undefined;
  try {
    if (session.role === "issue_execution") {
      const recorded = recordedIssueCompletion(
        session.workspaceId,
        session.issueId ?? "",
        session.id,
      );
      return recorded && issueSessionCompletion(session.id, inputId, recorded);
    }
    if (session.role === "issue_clarification") {
      const report = recoveredClarificationCompletion(
        session.workspaceId,
        session.issueId ?? "",
        session.id,
        inputId ?? "",
      );
      return report.clarificationResult ? report : undefined;
    }
    if (session.issueId) return undefined;
    const marker = readAgentSessionCompletionMarker(
      isVerificationSession(session)
        ? verificationDirectory(session.workspaceId, session.id)
        : workspacePath(),
      session.id,
      inputId ?? "",
    );
    return (
      marker && {
        sessionId: session.id,
        inputId,
        nativeSessionId: marker.nativeSessionId,
        response: marker.response,
      }
    );
  } catch {
    return undefined;
  }
}

const runInput: RunInput = (serverURL, workspacePath, transport, payload) =>
  payload.session.role === "issue_execution"
    ? runDispatchedIssue(serverURL, workspacePath, transport, payload)
    : runAgentSession(serverURL, workspacePath, transport, payload);

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
    if (!claims.claim(session.id, inputId)) return false;
    // A steer of the same message arriving late must not add it to this
    // input's own turn.
    if (inputId) noteSessionInput(session.id, inputId);
    // An input that already finished here (its report lost with an earlier
    // process) is reported again rather than run twice.
    const recorded = recordedCompletion(session, workspacePath);
    if (recorded) {
      transport.send(daemonMessageTypes.sessionCompleted, recorded);
      this.settle(session, inputId);
      return true;
    }
    const slotWait = slotWaitNotice(transport, session);
    this.track(
      scheduler.schedule(
        sessionSchedulingKey(session),
        async () => {
          slotWait.started(scheduler.load());
          console.log(
            payload.issue && session.role === "issue_execution"
              ? `Running ${payload.issue.shortId} (${payload.issue.title}) as session ${session.id}`
              : `Running ${session.provider} session ${session.id}`,
          );
          try {
            await (this.options.run ?? runInput)(
              this.options.serverURL,
              workspacePath(),
              transport,
              payload,
            );
          } catch (error) {
            reportWorkerFailure(transport, session, error);
          } finally {
            this.settle(session, inputId);
          }
        },
        slotWait.onWait,
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
