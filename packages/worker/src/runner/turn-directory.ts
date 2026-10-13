import { mkdirSync } from "node:fs";
import type { AgentSession } from "@bd777/foundry-protocol";
import { excludeFoundryRuntimeFromGit } from "../execution-git.js";
import {
  executionSessionsRoot,
  sessionInputDirectory,
} from "../session-artifacts.js";
import { within } from "../paths.js";
import { errorMessage } from "../utils.js";

/**
 * The workspace's `.foundry/sessions` (and Foundry's other runtime data) is
 * excluded from its repository locally once Foundry writes there.
 */
async function keepSessionsOutOfGit(workspacePath: string): Promise<void> {
  // Sandboxed runs keep their sessions in scratch, outside the workspace.
  if (!within(workspacePath, executionSessionsRoot(workspacePath))) return;
  try {
    await excludeFoundryRuntimeFromGit(workspacePath);
  } catch (error) {
    console.error(
      `Could not exclude Foundry's session files from Git in ${workspacePath}: ${errorMessage(error)}`,
    );
  }
}

/** The directory of a session input's records, made and kept out of Git. */
export async function prepareTurnDirectory(
  workspacePath: string,
  session: AgentSession,
): Promise<string> {
  const sessionDir = sessionInputDirectory(
    executionSessionsRoot(workspacePath),
    session,
  );
  mkdirSync(sessionDir, { recursive: true });
  await keepSessionsOutOfGit(workspacePath);
  return sessionDir;
}
