// Where a session's artifacts live on disk. A leaf module: the runner, the
// completion marker and the subagent reader all agree on one layout.

import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentSession } from "@foundry/protocol";

/**
 * One input's artifacts: `<root>/<sessionId>/inputs/<inputId>`. They are kept
 * per input, so an earlier input's completion marker can never settle a later
 * one. Worker-built sessions without an input keep the session directory.
 */
export function sessionInputDirectory(
  sessionsRoot: string,
  session: AgentSession,
): string {
  const sessionDir = resolve(sessionsRoot, session.id);
  return session.input
    ? resolve(sessionDir, "inputs", session.input.id)
    : sessionDir;
}

/**
 * Every artifact directory of a session, oldest input first (input ids sort
 * by time), then the session directory itself for runs without an input.
 */
export function sessionArtifactDirectories(
  sessionsRoot: string,
  sessionId: string,
): string[] {
  const sessionDir = resolve(sessionsRoot, sessionId);
  let inputs: string[] = [];
  try {
    inputs = readdirSync(resolve(sessionDir, "inputs")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return [...inputs.map((id) => resolve(sessionDir, "inputs", id)), sessionDir];
}
