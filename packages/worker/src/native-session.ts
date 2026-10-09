/**
 * Which native Claude Code or Codex session a turn runs in. The server names
 * the session's native session on this runtime and passes the turns it
 * missed elsewhere; this module checks that the device can resume it and
 * otherwise starts over, telling the new native session the Foundry
 * conversation. Both runners use it, so the rules live here once.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@bd777/foundry-protocol";
import { findSessionLog } from "./native-usage.js";
import { foundryToolsEndpoint } from "./session-ambient.js";
import {
  recordSkillReceipt,
  skillReceiptConflicts,
} from "./skill-isolation.js";

/** Why a native session that exists cannot be resumed. */
export type NativeRestartReason =
  "transcript_missing" | "other_workspace" | "resume_refused";

export type NativeSessionStart =
  /** Continue the named native session. */
  | { kind: "resume"; nativeSessionId: string }
  /** Claude: copy `from` into the new native session `nativeSessionId`. */
  | { kind: "fork"; from: string; nativeSessionId: string }
  /**
   * Start a native session. With a reason it replaces one that cannot be
   * resumed and is told the whole Foundry conversation; without one the
   * server's context already covers what it has not seen.
   */
  | { kind: "new"; reason?: NativeRestartReason };

export interface NativeSessionFacts {
  /** The native session the server asks to resume (or to fork into). */
  nativeSessionId?: string;
  /** Set for a fork that has not answered yet: the native session to copy. */
  forkFrom?: string;
  /** This runtime can fork a native session (Claude). */
  canFork: boolean;
  /** This device holds the transcript of `nativeSessionId`. */
  transcriptPresent: boolean;
  /** This device holds the transcript of `forkFrom`. */
  forkSourcePresent: boolean;
  /** A Foundry receipt says the native session belongs to another workspace. */
  receiptConflicts: boolean;
  /** The runtime refused to resume it on the previous attempt. */
  resumeRefused?: boolean;
}

export function decideNativeSession(
  facts: NativeSessionFacts,
): NativeSessionStart {
  const id = facts.nativeSessionId?.trim();
  if (!id) return { kind: "new" };
  if (facts.resumeRefused) return { kind: "new", reason: "resume_refused" };
  if (facts.receiptConflicts) return { kind: "new", reason: "other_workspace" };
  const from = facts.forkFrom?.trim();
  if (from && !facts.transcriptPresent)
    return facts.canFork && facts.forkSourcePresent
      ? { kind: "fork", from, nativeSessionId: id }
      : { kind: "new", reason: "transcript_missing" };
  if (!facts.transcriptPresent)
    return { kind: "new", reason: "transcript_missing" };
  return { kind: "resume", nativeSessionId: id };
}

/**
 * Errors with which a runtime refuses to continue a native session: its
 * transcript is not where the CLI looks, or the endpoint rejects the history
 * (for example thinking signatures or encrypted reasoning another provider
 * wrote).
 */
export function nativeResumeRefused(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return [
    /No conversation found with session ID/i,
    /invalid\W{0,3}signature/i,
    /signature\b.{0,80}\bthinking|thinking\b.{0,80}\bsignature/i,
    /invalid_encrypted_content|encrypted content.{0,60}(could not|cannot) be (decrypted|verified)/i,
  ].some((pattern) => pattern.test(message));
}

const restartNotices: Record<NativeRestartReason, string> = {
  transcript_missing:
    "This device has no native transcript of the conversation",
  other_workspace:
    "The native session belongs to another workspace folder on this device",
  resume_refused: "The runtime refused to continue the native session",
};

export interface NativeSessionRun {
  provider: "claude" | "codex";
  session: AgentSession;
  workspacePath: string;
  /** The environment the runtime starts with: it decides the config home. */
  env: NodeJS.ProcessEnv;
  /** Workspace skill isolation applies: receipts are read and written. */
  isolated: boolean;
  emit: (
    label: string,
    detail: string,
    level?: "info" | "warning",
  ) => Promise<void>;
  reportNativeSessionId: (nativeSessionId: string) => void;
}

/**
 * Runs one turn on the session's native session, prepared by
 * decideNativeSession. When the runtime refuses to resume it, the turn runs
 * once more in a new native session told the Foundry conversation.
 */
export async function runOnNativeSession<T>(
  run: NativeSessionRun,
  turn: (
    session: AgentSession,
    start: NativeSessionStart,
    reportNativeSessionId: (nativeSessionId: string) => void,
  ) => Promise<T>,
): Promise<T> {
  const report = (id: string) => {
    if (id && run.isolated) recordSkillReceipt(id, run.workspacePath);
    run.reportNativeSessionId(id);
  };
  const first = await prepareNativeSession(run);
  try {
    return await turn(first.session, first.start, report);
  } catch (error) {
    if (first.start.kind === "new" || !nativeResumeRefused(error)) throw error;
    const retry = await prepareNativeSession(run, true);
    return turn(retry.session, retry.start, report);
  }
}

export async function prepareNativeSession(
  run: NativeSessionRun,
  resumeRefused = false,
): Promise<{ session: AgentSession; start: NativeSessionStart }> {
  const { session, provider } = run;
  const id = session.nativeSessionId?.trim();
  const from = session.forkNativeSessionId?.trim();
  const homes = [nativeHome(provider, run.env)];
  const present = async (nativeId: string | undefined) =>
    Boolean(nativeId && (await findSessionLog(provider, nativeId, homes)));
  const start = decideNativeSession({
    nativeSessionId: id,
    forkFrom: from,
    canFork: provider === "claude",
    transcriptPresent: await present(id),
    forkSourcePresent: await present(from),
    receiptConflicts: Boolean(
      id && run.isolated && skillReceiptConflicts(id, run.workspacePath),
    ),
    resumeRefused,
  });
  if (start.kind === "resume")
    return {
      start,
      session: { ...session, forkNativeSessionId: undefined },
    };
  if (start.kind === "fork") return { start, session };
  const fresh: AgentSession = {
    ...session,
    nativeSessionId: undefined,
    forkNativeSessionId: undefined,
  };
  if (!start.reason) return { start, session: fresh };
  const conversation = await foundryConversation(session);
  await run.emit(
    "Started a new native session",
    `${restartNotices[start.reason]}; ${
      conversation === undefined
        ? "the Foundry conversation could not be read, so it starts with only the turns the server passed."
        : "it was given the Foundry conversation."
    }`,
    "warning",
  );
  return {
    start,
    session: {
      ...fresh,
      input: fresh.input && {
        ...fresh.input,
        importedContext: conversation || fresh.input.importedContext,
      },
    },
  };
}

/** The config home the runtime keeps its native sessions in. */
function nativeHome(
  provider: "claude" | "codex",
  env: NodeJS.ProcessEnv,
): string {
  return provider === "claude"
    ? env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude")
    : env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

/**
 * The session's Foundry conversation before this turn, read from the server
 * with the session's own token; undefined when it cannot be read.
 */
async function foundryConversation(
  session: AgentSession,
): Promise<string | undefined> {
  const tools = foundryToolsEndpoint(session);
  if (!tools) return undefined;
  try {
    const response = await fetch(
      new URL(
        `/api/agent-sessions/${encodeURIComponent(session.id)}/conversation`,
        tools.url,
      ),
      {
        headers: { Authorization: `Bearer ${tools.token}` },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) return undefined;
    const body = (await response.json()) as { text?: unknown };
    return typeof body.text === "string" ? body.text : undefined;
  } catch {
    return undefined;
  }
}
