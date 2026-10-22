import { acquireRuntime } from "../agent-runtime/maintenance.js";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentSession } from "@bd777/foundry-protocol";
import { CodexContextFollower } from "../context-usage.js";
import { nativeExecutionHome } from "../native-runtime-paths.js";
import {
  prepareExecution,
  type PreparedExecution,
} from "../session/preparation/index.js";
import { configuredWindow } from "../context-window.js";
import { officialSkills, refreshOfficialSkills } from "../official-skills.js";
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
import { validateWorkspaceSkillPrompt } from "../skill-isolation.js";
import type { ManagedSkillRuntime } from "../skill-materializer.js";
import { turnUsageMetadata } from "../turn-usage.js";
import { codexSessionInput } from "./codex-options.js";
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
  // Codex's own skills stay available under workspace isolation; they
  // are read once per installed version.
  if (managedSkills && !managedSkills.officialSkills) {
    if (!officialSkills("codex"))
      await refreshOfficialSkills(["codex"]).catch(() => false);
    if (officialSkills("codex")) {
      managedSkills = {
        ...managedSkills,
        officialSkills: officialSkills("codex"),
      };
    }
  }
  if (managedSkills) {
    if (managedSkills.officialSkills && managedSkills.officialSkills.length > 0)
      validateWorkspaceSkillPrompt(currentInput(session).prompt, managedSkills);
    if (profile.command?.trim())
      throw new Error(
        "Custom runtime commands cannot enforce workspace skill isolation.",
      );
  }
  const execution = await prepareExecution({
    purpose: "workspace",
    ownerId: session.id,
    workspacePath,
    session,
    profile,
    managedSkills,
  });
  profile = execution.native.profile;
  managedSkills = execution.native.managedSkills;
  if (managedSkills) {
    validateWorkspaceSkillPrompt(currentInput(session).prompt, managedSkills);
  }
  try {
    return await runOnNativeSession(
      {
        provider: "codex",
        session,
        workspacePath,
        env: execution.native.env,
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
          execution,
        ),
    );
  } finally {
    await execution.dispose();
  }
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
  execution?: PreparedExecution,
): Promise<AgentSessionRunResult> {
  const startedAt = Date.now();
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
    const env = execution!.native.env;
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
      inputId: session.input?.id,
      emit,
      reportNativeSessionId,
      files,
      eventsPath,
      thread,
      context: new CodexContextFollower(
        [nativeExecutionHome("codex", env)],
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

    if (streamsCodexEvents(thread.thread)) {
      const minutes = session.input?.executionBudget?.timeoutMinutes;
      if (minutes && minutes > 0)
        state.ceilingMs = Math.min(minutes, 240) * 60_000;
      await runCodexStreamedTurn(state, thread.thread, input, session.id);
    } else {
      if (session.input?.executionBudget)
        throw new Error(
          "This Codex transport cannot enforce a role run deadline; use a streaming native runtime.",
        );
      await runCodexUnstreamedTurn(state, thread.thread, input);
    }
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
