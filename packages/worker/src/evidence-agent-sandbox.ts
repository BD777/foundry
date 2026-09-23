import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { delimiter } from "node:path";
import { controlNetworkRestrictions } from "./execution-sandbox.js";
import { within } from "./execution-storage.js";

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
  if (process.platform !== "darwin")
    throw new Error("agent_verifier_isolation_unavailable");
  home = realpathSync(home);
  const executable = isAbsolute(command)
    ? realpathSync(command)
    : (process.env.PATH ?? "")
        .split(delimiter)
        .map((root) => resolve(root, command))
        .filter(existsSync)
        .map((path) => realpathSync(path))[0];
  if (!executable) throw new Error("verifier_executable_missing");
  const readRoots = (options.readRoots ?? [])
    .filter(existsSync)
    .map((path) => realpathSync(path));
  const workdir = options.workdir ? realpathSync(options.workdir) : home;
  if (workdir !== home && !readRoots.some((root) => within(root, workdir)))
    throw new Error("stage_workdir_not_readable");
  // Beyond these roots: no source trees, global user config, project skills or
  // original materials. Only the private home is ever writable.
  const roots = [
    "/usr",
    "/bin",
    "/sbin",
    "/System",
    "/Library",
    "/opt/homebrew",
    "/private/etc",
    "/private/var/db",
    dirname(executable),
    home,
    ...readRoots,
  ];
  const profile = [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow signal (target self))",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow file-read-metadata)",
    "(allow network-outbound)",
    "(allow network-bind)",
    '(allow file-read-data (literal "/") (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))',
    ...roots.map(
      (path) => `(allow file-read-data (subpath ${JSON.stringify(path)}))`,
    ),
    '(allow file-write* (literal "/dev/null"))',
    `(allow file-write* (subpath ${JSON.stringify(home)}))`,
    ...controlNetworkRestrictions(options.serverURL),
  ].join("\n");
  const profilePath = resolve(home, "..", "verifier.sb");
  writeFileSync(profilePath, profile, { mode: 0o400, flag: "wx" });
  const wrapper = resolve(home, "..", "verifier-cli");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(
    wrapper,
    `#!/bin/sh\ncd ${quote(workdir)} || exit 1\nexec /usr/bin/sandbox-exec -f ${quote(profilePath)} ${quote(executable)} "$@"\n`,
    { mode: 0o500, flag: "wx" },
  );
  return wrapper;
}
