import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// TODO(native-prompts): pastes AGENTS.md / CLAUDE.md into a prompt as text
// instead of the agent loading them natively. Unused today (every read-only
// policy has projectInstructions false); delete with the Issue role refactor.
/** Instructions are admitted explicitly; project settings/hooks/MCP are not. */
export function claudeWorkspaceInstructions(workspacePath: string): string {
  const entries: string[] = [];
  for (const name of ["AGENTS.md", "CLAUDE.md", ".claude/CLAUDE.md"]) {
    try {
      const text = readFileSync(resolve(workspacePath, name), "utf8").trim();
      if (Buffer.byteLength(text) > 128 * 1024)
        throw new Error(`Workspace instruction ${name} exceeds 128 KiB.`);
      if (text) entries.push(`Workspace instructions (${name}):\n${text}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return entries.join("\n\n");
}
