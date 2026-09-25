import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { isSandboxError, sandboxLauncher } from "./sandbox/index.js";

/** Capabilities no evidence stage session may use, whatever its directory. */
const unavailableStageFeatures = [
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

const shellFeatures = ["shell_tool", "unified_exec", "shell_snapshot"];

/**
 * Codex feature switches. A stage that works inside a real directory reads it
 * through Codex's own read-only sandboxed shell; a detached judging session
 * keeps the shell off because it has nothing to inspect.
 */
export function stageDisabledFeatures(shell: boolean): Record<string, boolean> {
  return Object.fromEntries(
    [...unavailableStageFeatures, ...(shell ? [] : shellFeatures)].map(
      (name) => [name, false],
    ),
  );
}

/** Defense in depth even if a provider ignores a disabled-tool setting. */
export function stageSandboxExecutable(
  command: string,
  home: string,
  options: {
    serverURL?: string;
    /** Directories the session may read. It can never write to them. */
    readRoots?: string[];
    /** Initial working directory; defaults to the private home. */
    workdir?: string;
  } = {},
): string {
  try {
    // The policy and launcher live beside the private home, outside it.
    const stage = resolve(realpathSync(home), "..");
    return sandboxLauncher(
      {
        kind: "readonly_agent",
        policyFile: resolve(stage, "verifier.sb"),
        home,
        readRoots: options.readRoots ?? [],
        workdir: options.workdir,
        controlServerURL: options.serverURL,
      },
      command,
      resolve(stage, "verifier-cli"),
    );
  } catch (error) {
    if (!isSandboxError(error)) throw error;
    switch (error.code) {
      case "executable_missing":
        throw new Error("verifier_executable_missing");
      case "workdir_not_readable":
        throw new Error("stage_workdir_not_readable");
      default:
        throw new Error("agent_verifier_isolation_unavailable");
    }
  }
}
