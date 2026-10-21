import {
  AgentSessionCanceledError,
  registerActiveSessionCancelTarget,
} from "../session-control.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentSession } from "@bd777/foundry-protocol";
import { spawnAgentProcess, stopAgentProcess } from "../agent-processes.js";
import {
  maskCommand,
  profileID,
  type AgentProfileLocalConfig,
} from "../profiles.js";
import { sessionEnvironment } from "../session-ambient.js";
import { executionSessionsRoot } from "../session-artifacts.js";
import { SessionTurnFiles } from "../session-files.js";
import { sessionPrompt } from "../session-prompt.js";
import type {
  AgentSessionRunResult,
  SessionEventEmitter,
} from "../session-state.js";
import { sendPrompt } from "../utils.js";
import { isUtilitySession } from "../session-roles.js";

/** A turn run by the profile's own command instead of an agent SDK. */
export async function runProfileCommandSession(
  workspacePath: string,
  session: AgentSession,
  sessionDir: string,
  profile: AgentProfileLocalConfig,
  emit: SessionEventEmitter,
): Promise<AgentSessionRunResult> {
  const files = SessionTurnFiles.forSession(
    workspacePath,
    executionSessionsRoot(workspacePath),
    session,
    emit,
  );
  const command = profile.command?.trim();
  if (!command) {
    throw new Error(
      `${profile.label ?? profile.runtime} does not have a command configured`,
    );
  }
  const stdoutPath = resolve(sessionDir, `${profileID(profile)}.stdout.log`);
  const stderrPath = resolve(sessionDir, `${profileID(profile)}.stderr.log`);
  const resultPath = resolve(sessionDir, "result.md");
  const prompt = sessionPrompt(session, profile);
  await emit("Started custom profile command", maskCommand(command) ?? command);

  let canceled = false;
  let timedOut = false;
  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolveRun, rejectRun) => {
    const child = spawnAgentProcess("sh", ["-lc", command], {
      cwd: workspacePath,
      env: {
        ...sessionEnvironment(workspacePath, profile, session),
        FOUNDRY_RESULT_FILE: resultPath,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const unregisterCancel = registerActiveSessionCancelTarget(session.id, {
      provider: profile.runtime,
      inputId: session.input?.id,
      cancel: () => {
        canceled = true;
        stopAgentProcess(child);
      },
    });
    let timeoutMs = Number(
      process.env.FOUNDRY_SESSION_TIMEOUT_MS ??
        (isUtilitySession(session) ? 180000 : 900000),
    );
    const minutes = session.input?.executionBudget?.timeoutMinutes;
    if (minutes && minutes > 0)
      timeoutMs = Math.min(timeoutMs, Math.min(minutes, 240) * 60_000);
    const timeout = setTimeout(() => {
      timedOut = true;
      stopAgentProcess(child);
    }, timeoutMs);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      unregisterCancel();
      rejectRun(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      unregisterCancel();
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      writeFileSync(stdoutPath, stdoutText);
      writeFileSync(stderrPath, stderrText);
      resolveRun({ code, signal, stdout: stdoutText, stderr: stderrText });
    });
    sendPrompt(child, prompt);
  });

  if (canceled) throw new AgentSessionCanceledError();
  if (timedOut) throw new Error("The configured run time limit was reached.");
  if (result.code !== 0) {
    throw new Error(
      `${profile.label ?? profile.runtime} exited with ${result.signal ?? result.code}: ${result.stderr.trim()}`,
    );
  }

  const response = existsSync(resultPath)
    ? readFileSync(resultPath, "utf8").trim()
    : result.stdout.trim();
  writeFileSync(
    resultPath,
    `${response || "Profile command completed without a text response."}\n`,
  );
  const fileReferences = await files.finish(response);
  await emit(
    "Custom profile command finished",
    resultPath,
    undefined,
    fileReferences.length > 0 ? { fileReferences } : undefined,
  );
  return {
    response: response || "Profile command completed without a text response.",
  };
}
