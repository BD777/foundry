import { writeFileSync } from "node:fs";
import type { AgentSession } from "@bd777/foundry-protocol";
import {
  runOnNativeSession,
  type NativeSessionStart,
} from "../native-session.js";
import { officialSkills, refreshOfficialSkills } from "../official-skills.js";
import type { AgentProfileLocalConfig } from "../profiles.js";
import { ClaudeAgentTurnError } from "../sdk-messages.js";
import { sessionEnvironment, withoutSessionToken } from "../session-ambient.js";
import { executionSessionsRoot } from "../session-artifacts.js";
import { SessionTurnFiles } from "../session-files.js";
import {
  buildClaudeLaunchPlan,
  validateClaudeLaunch,
  type ClaudeLaunchPlan,
} from "../session-policy.js";
import type {
  AgentSessionRunResult,
  SessionEventEmitter,
} from "../session-state.js";
import type { ManagedSkillRuntime } from "../skill-materializer.js";
import {
  claudePermissionMode,
  claudeRootBypassRefusal,
} from "./claude-options.js";
import { prepareClaudeTurnRun } from "./claude-launch.js";
import {
  acquireClaudeRuntime,
  sendClaudeTurnPrompt,
} from "./claude-runtime-start.js";
import {
  openClaudeTurn,
  registerClaudeTurnControls,
} from "./claude-turn-controls.js";
import { runProfileCommandSession } from "./profile-command.js";
import { prepareTurnDirectory } from "./turn-directory.js";

export async function runClaudeWorkspaceSession(
  workspacePath: string,
  session: AgentSession,
  profile: AgentProfileLocalConfig,
  emit: SessionEventEmitter,
  emitSetup: () => Promise<void>,
  reportNativeSessionId: (nativeSessionId: string) => void,
  managedSkills?: ManagedSkillRuntime,
): Promise<AgentSessionRunResult> {
  // Claude Code's own skills stay available under workspace isolation; they
  // are read once per installed version.
  if (managedSkills && !managedSkills.officialSkills) {
    if (!officialSkills("claude")) await refreshOfficialSkills(["claude"]);
    managedSkills = {
      ...managedSkills,
      officialSkills: officialSkills("claude") ?? [],
    };
  }
  // Fail-closed validation (managed skills reject custom commands and
  // unconfigured invocations) before any directory or process work happens.
  validateClaudeLaunch({ session, profile, managedSkills });
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
  const refusal = claudeRootBypassRefusal(
    claudePermissionMode(session, profile),
  );
  if (refusal) throw new ClaudeAgentTurnError("root_bypass", refusal);
  return runOnNativeSession(
    {
      provider: "claude",
      session,
      workspacePath,
      env: withoutSessionToken(
        sessionEnvironment(workspacePath, profile, session),
      ),
      isolated: Boolean(managedSkills),
      emit: (label, detail, level) => emit(label, detail, level),
      reportNativeSessionId,
    },
    async (prepared, start, report) => {
      const plan = buildClaudeLaunchPlan({
        workspacePath,
        session: prepared,
        profile,
        managedSkills,
      });
      for (const warning of plan.warnings) {
        await emit("Connection credential missing", warning, "warning");
      }
      return runClaudeAgentSdkSession(
        workspacePath,
        prepared,
        sessionDir,
        profile,
        emit,
        emitSetup,
        report,
        managedSkills,
        plan,
        start,
      );
    },
  );
}

export {
  claudeTurnLivenessError,
  claudeTurnLivenessNotice,
  waitsForBackgroundWork,
} from "./claude-turn-controls.js";

export async function runClaudeAgentSdkSession(
  workspacePath: string,
  session: AgentSession,
  sessionDir: string,
  profile: AgentProfileLocalConfig,
  emit: SessionEventEmitter,
  emitSetup: () => Promise<void>,
  reportNativeSessionId: (nativeSessionId: string) => void,
  managedSkills?: ManagedSkillRuntime,
  plan?: ClaudeLaunchPlan,
  start?: NativeSessionStart,
): Promise<AgentSessionRunResult> {
  const run = await prepareClaudeTurnRun({
    workspacePath,
    session,
    sessionDir,
    profile,
    emit,
    emitSetup,
    reportNativeSessionId,
    managedSkills,
    plan,
    start,
  });
  // A fork's native session exists once Claude reports it.
  if (start?.kind !== "fork")
    reportNativeSessionId(run.requestedNativeSessionId);

  try {
    const { runtime, startOptions } = await acquireClaudeRuntime(run);
    if (runtime.pending) {
      throw new Error("Claude active runtime already has a pending turn");
    }
    writeFileSync(run.messagesPath, "");
    writeFileSync(run.stderrPath, "");
    runtime.messagesPath = run.messagesPath;
    const files = SessionTurnFiles.forSession(
      workspacePath,
      executionSessionsRoot(workspacePath),
      session,
      emit,
      run.startedAt,
    );
    return await new Promise<AgentSessionRunResult>(
      (resolveTurn, rejectTurn) => {
        const unregisterControls = registerClaudeTurnControls(run, runtime);
        runtime.pending = openClaudeTurn(
          run,
          runtime,
          files,
          startOptions !== undefined,
          {
            resolve: (result) => {
              unregisterControls();
              resolveTurn(result);
            },
            reject: (error) => {
              unregisterControls();
              rejectTurn(error);
            },
          },
        );
        sendClaudeTurnPrompt(run, runtime, startOptions);
      },
    );
  } catch (error) {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    writeFileSync(run.stderrPath, `${message}\n`);
    throw error;
  }
}
