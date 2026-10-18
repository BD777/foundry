import { acquireRuntime } from "../agent-runtime/maintenance.js";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentSession } from "@bd777/foundry-protocol";
import { CodexContextFollower, codexHome } from "../context-usage.js";
import { configuredWindow } from "../context-window.js";
import { runOnNativeSession } from "../native-session.js";
import type { AgentProfileLocalConfig } from "../profiles.js";
import { executionSessionsRoot } from "../session-artifacts.js";
import { isAgentSessionCanceledError } from "../session-control.js";
import { SessionTurnFiles } from "../session-files.js";
import { currentInput, sessionPrompt } from "../session-prompt.js";
import { isUtilitySession } from "../session-roles.js";
import type {
  AgentSessionRunResult,
  SessionEventEmitter,
} from "../session-state.js";
import {
  prepareCodexSkillIsolation,
  validateWorkspaceSkillPrompt,
} from "../skill-isolation.js";
import type { ManagedSkillRuntime } from "../skill-materializer.js";
import { turnUsageMetadata } from "../turn-usage.js";
import { codexSessionEnvironment, codexSessionInput } from "./codex-options.js";
import {
  runCodexStreamedTurn,
  runCodexUnstreamedTurn,
  streamsCodexEvents,
  type CodexTurnState,
} from "./codex-stream.js";
import { openCodexThread } from "./codex-thread.js";
import {
  CodexTransportLearner,
  codexTransportPlan,
} from "./codex-transport.js";
import { runProfileCommandSession } from "./profile-command.js";
import { prepareTurnDirectory } from "./turn-directory.js";

export { nativeSessionIdFromEvent } from "./codex-stream.js";

async function runCodexWorkspaceSessionUnlocked(
  workspacePath: string,
  session: AgentSession,
  profile: AgentProfileLocalConfig,
  emit: SessionEventEmitter,
  emitSetup: () => Promise<void>,
  reportNativeSessionId: (nativeSessionId: string) => void,
  managedSkills?: ManagedSkillRuntime,
): Promise<AgentSessionRunResult> {
  if (managedSkills) {
    validateWorkspaceSkillPrompt(currentInput(session).prompt, managedSkills);
    if (profile.command?.trim())
      throw new Error(
        "Custom runtime commands cannot enforce workspace skill isolation.",
      );
  }
  return runOnNativeSession(
    {
      provider: "codex",
      session,
      workspacePath,
      env: codexSessionEnvironment(workspacePath, profile, session),
      isolated: Boolean(managedSkills),
      emit: (label, detail, level) => emit(label, detail, level),
      reportNativeSessionId,
    },
    (prepared, _start, report) =>
      runCodexTurn(
        workspacePath,
        prepared,
        profile,
        emit,
        emitSetup,
        report,
        managedSkills,
      ),
  );
}

/** One Codex turn on the native thread the session was prepared with. */
async function runCodexTurn(
  workspacePath: string,
  session: AgentSession,
  profile: AgentProfileLocalConfig,
  emit: SessionEventEmitter,
  emitSetup: () => Promise<void>,
  reportNativeSessionId: (nativeSessionId: string) => void,
  managedSkills?: ManagedSkillRuntime,
): Promise<AgentSessionRunResult> {
  const startedAt = Date.now();
  if (managedSkills) {
    managedSkills = await prepareCodexSkillIsolation(
      managedSkills,
      workspacePath,
      codexSessionEnvironment(workspacePath, profile, session),
    );
  }
  const sessionDir = await prepareTurnDirectory(workspacePath, session);
  if (profile.command?.trim()) {
    await emitSetup();
    return runProfileCommandSession(
      workspacePath,
      session,
      sessionDir,
      profile,
      emit,
    );
  }
  const files = SessionTurnFiles.forSession(
    workspacePath,
    executionSessionsRoot(workspacePath),
    session,
    emit,
    startedAt,
  );
  const eventsPath = resolve(sessionDir, "codex-sdk.events.jsonl");
  const stderrPath = resolve(sessionDir, "codex-sdk.stderr.log");
  const resultPath = resolve(sessionDir, "result.md");

  try {
    writeFileSync(eventsPath, "");
    writeFileSync(stderrPath, "");
    const env = codexSessionEnvironment(workspacePath, profile, session);
    const thread = await openCodexThread({
      workspacePath,
      session,
      profile,
      env,
      emit,
      emitSetup,
      managedSkills,
    });
    const state: CodexTurnState = {
      emit,
      reportNativeSessionId,
      files,
      eventsPath,
      thread,
      context: new CodexContextFollower(
        [env.CODEX_HOME?.trim() || codexHome(env)],
        configuredWindow(profile.contextWindow),
      ),
      nativeSessionId:
        session.nativeSessionId?.trim() || thread.thread.id || "",
      finalResult: "",
      managedSkills,
      transport: new CodexTransportLearner(
        codexTransportPlan(profile),
        profile,
        emit,
      ),
    };
    reportNativeSessionId(state.nativeSessionId);
    const input = codexSessionInput(session, sessionPrompt(session, profile));
    // Codex reports no diffs: its changes are diffed against the work tree
    // as the turn started. Naming and other utility sessions write nothing.
    if (!isUtilitySession(session)) await files.snapshotWorkTree();
    if (state.nativeSessionId)
      await state.context.follow(state.nativeSessionId, { resumed: true });

    if (streamsCodexEvents(thread.thread))
      await runCodexStreamedTurn(state, thread.thread, input, session.id);
    else await runCodexUnstreamedTurn(state, thread.thread, input);
    return await finishCodexTurn(state, resultPath, startedAt);
  } catch (error) {
    if (isAgentSessionCanceledError(error)) {
      throw error;
    }
    writeFileSync(
      stderrPath,
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    throw error;
  }
}

/** Records the turn's answer, usage and files on the thread and the transcript. */
async function finishCodexTurn(
  state: CodexTurnState,
  resultPath: string,
  startedAt: number,
): Promise<AgentSessionRunResult> {
  state.thread.nativeSessionId = state.nativeSessionId;
  state.thread.lastUsed = Date.now();
  const response =
    state.finalResult || "Codex completed without a text response.";
  writeFileSync(resultPath, `${response}\n`);
  const fileReferences = await state.files.finish(state.finalResult);
  await state.emit("Codex finished", resultPath, undefined, {
    ...turnUsageMetadata(state.usage, startedAt),
    ...(fileReferences.length > 0 ? { fileReferences } : {}),
  });
  return { nativeSessionId: state.nativeSessionId, response };
}

/** Pin the runtime before resolving its executable, SDK or native session. */
export async function runCodexWorkspaceSession(
  ...args: Parameters<typeof runCodexWorkspaceSessionUnlocked>
): Promise<AgentSessionRunResult> {
  const release = await acquireRuntime("codex");
  try {
    return await runCodexWorkspaceSessionUnlocked(...args);
  } finally {
    release();
  }
}
