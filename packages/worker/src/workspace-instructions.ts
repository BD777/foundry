import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

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

/**
 * What a workspace session's Claude Code does not read itself: it loads
 * CLAUDE.md and .claude/CLAUDE.md natively, AGENTS.md only when one of them
 * is a link to it or imports it (@AGENTS.md). Otherwise Foundry passes it on.
 */
export function claudeAgentsInstructions(workspacePath: string): string {
  let agents: string;
  try {
    agents = realpathSync(resolve(workspacePath, "AGENTS.md"));
  } catch {
    return "";
  }
  for (const name of ["CLAUDE.md", ".claude/CLAUDE.md"]) {
    try {
      const path = resolve(workspacePath, name);
      // A link to AGENTS.md, or a file that imports it.
      if (
        realpathSync(path) === agents ||
        /@AGENTS\.md\b/.test(readFileSync(path, "utf8"))
      )
        return "";
    } catch {
      /* Absent: Claude Code has nothing of its own to read here. */
    }
  }
  const text = readFileSync(agents, "utf8").trim();
  if (Buffer.byteLength(text) > 128 * 1024)
    throw new Error("Workspace instruction AGENTS.md exceeds 128 KiB.");
  return text ? `Workspace instructions (AGENTS.md):\n${text}` : "";
}
