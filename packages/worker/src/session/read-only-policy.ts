/** What a read-only session (the independent judge) may do, derived only from whether it has a directory. */
export interface ReadOnlyPolicy {
  /** Built-in tools the session may use without asking. */
  tools: string[];
  /** Built-in tools refused outright. */
  deniedTools: string[];
  /** A shell for read-only checks inside the directory. */
  commands: boolean;
  maxTurns: number;
  timeoutMs: number;
}

/**
 * Verification may run read-only checks on the candidate and ignores the
 * project's instructions. Without a directory a session has no tools at all.
 */
export function readOnlyPolicy(hasDirectory: boolean): ReadOnlyPolicy {
  if (!hasDirectory)
    return {
      tools: [],
      deniedTools: [],
      commands: false,
      maxTurns: 1,
      timeoutMs: 180000,
    };
  return {
    tools: ["Read", "Grep", "Glob", "Bash"],
    deniedTools: [
      "Write",
      "Edit",
      "MultiEdit",
      "NotebookEdit",
      "Task",
      "WebFetch",
      "WebSearch",
    ],
    commands: true,
    maxTurns: 30,
    timeoutMs: 900000,
  };
}

/** Codex capabilities no read-only session may use, whatever its directory. */
const unavailableCodexFeatures = [
  "apps",
  "plugins",
  "hooks",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "in_app_browser",
  "image_generation",
  "multi_agent",
  "multi_agent_v2",
  "goals",
  "workspace_dependencies",
  "memories",
  "code_mode",
  "code_mode_only",
  "tool_suggest",
  "skill_mcp_dependency_install",
  "tool_call_mcp_elicitation",
  "request_permissions_tool",
  "network_proxy",
];

const codexShellFeatures = ["shell_tool", "unified_exec", "shell_snapshot"];

/**
 * Codex feature switches. A session with files to read (a real directory, or
 * PDFs it is given) reads them through Codex's own read-only sandboxed shell;
 * a session with nothing to inspect keeps the shell off.
 */
export function codexDisabledFeatures(shell: boolean): Record<string, boolean> {
  return Object.fromEntries(
    [...unavailableCodexFeatures, ...(shell ? [] : codexShellFeatures)].map(
      (name) => [name, false],
    ),
  );
}
