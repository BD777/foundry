/** Workspace skill discovery policy, shared by SDK and CLI execution. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentSession } from "@foundry/protocol";
import type { ManagedSkillRuntime } from "./skill-materializer.js";
import { foundryStatePath } from "./state-root.js";
import { withCodexControl } from "./native-inspection.js";

export function workspaceSkillInstructions(
  managed: ManagedSkillRuntime,
): string {
  return [
    "Foundry workspace skill policy: the following is the complete allowed skill catalog for this workspace session.",
    "Use only these managed copies, including when a user names a skill or a skill references another skill. Do not discover, read, or invoke skills from device-local installations, plugins, other workspaces, or earlier conversation context. If a requested skill is absent, say it must be promoted and selected for this workspace first. Ordinary project source files remain available.",
    ...managed.skills.map((skill) =>
      JSON.stringify({
        name: skill.name,
        description: skill.description ?? "",
        file: join(skill.dir, "SKILL.md"),
      }),
    ),
    ...(managed.skills.length
      ? []
      : ["No skills are configured for this workspace session."]),
  ].join("\n");
}

/** Preserve repository instructions explicitly without enabling project skill discovery. */
export function workspaceProjectInstructions(cwd: string): string {
  const git = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    timeout: 2000,
  });
  const canonicalCwd = realpathSync(cwd);
  const root =
    git.status === 0 ? realpathSync(git.stdout.trim()) : canonicalCwd;
  const dirs: string[] = [];
  for (let dir = canonicalCwd; ; dir = dirname(dir)) {
    dirs.unshift(dir);
    if (dir === root || dirname(dir) === dir) break;
  }
  const documents: string[] = [];
  for (const dir of dirs)
    for (const name of ["AGENTS.md", "CLAUDE.md", ".claude/CLAUDE.md"]) {
      const path = join(dir, name);
      try {
        const text = readFileSync(path, "utf8");
        if (Buffer.byteLength(text) > 256 * 1024)
          throw new Error(`Workspace instruction file is too large: ${path}`);
        documents.push(`Project instructions from ${path}:\n${text}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  return documents.join("\n\n");
}

export function claudeManagedPrompt(
  prompt: string,
  managed: ManagedSkillRuntime | undefined,
): string {
  if (!managed) return prompt;
  return prompt.replace(/^\s*\/([\w-]+)(?=\s|$)/, (match, name: string) =>
    managed.skills.some((skill) => skill.name === name)
      ? `/foundry-workspace:${name}`
      : match,
  );
}

// Native commands are distinct from user-installed skills. Keep this deliberately
// small: unrecognized slash commands must never trigger a host skill by name.
const nativeCommands = new Set([
  "compact",
  "context",
  "usage",
  "clear",
  "help",
]);
export function validateWorkspaceSkillPrompt(
  prompt: string,
  managed: ManagedSkillRuntime,
): void {
  const name = prompt.trimStart().match(/^[/\$]([\w:-]+)(?=\s|$)/)?.[1];
  if (!name || nativeCommands.has(name)) return;
  const unqualified = name.replace(/^foundry-workspace:/, "");
  if (!managed.skills.some((skill) => skill.name === unqualified)) {
    throw new Error(
      `Skill "${name}" is not configured for this workspace. Promote it and select it in Workspace Skills first.`,
    );
  }
}

/** Use the native inventory, including custom CODEX_HOME, .agents, ancestors,
 * admin and plugin roots. No package content scans or model requests are needed.
 * Config rules select existing skills; they do NOT mount additional paths.
 * Disable native skills by document path and supply only our verified catalog.
 */
export async function prepareCodexSkillIsolation(
  managed: ManagedSkillRuntime,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<ManagedSkillRuntime> {
  const paths = await withCodexControl(
    "",
    async (call) => {
      const result = await call("skills/list", {
        cwds: [cwd],
        forceReload: true,
      });
      if (!Array.isArray(result?.data) || result.data.length !== 1) {
        throw new Error(
          "Cannot verify native Codex skill inventory; refusing to start.",
        );
      }
      const entry = result.data[0];
      if (!Array.isArray(entry.skills) || entry.errors?.length) {
        throw new Error(
          "Native Codex skill discovery failed; refusing unisolated execution.",
        );
      }
      return entry.skills.map((skill: { path: string }) => {
        if (typeof skill.path !== "string" || !skill.path.startsWith("/")) {
          throw new Error("Native Codex returned an invalid skill path.");
        }
        return skill.path;
      });
    },
    { cwd, env, args: ["-c", "skills.bundled.enabled=false"] },
  );
  return { ...managed, hostSkillPaths: [...new Set<string>(paths)].sort() };
}

const policyVersion = "workspace-skills-v2";
function receiptPath(nativeID: string): string {
  const key = createHash("sha256").update(nativeID).digest("hex");
  return process.env.FOUNDRY_EXECUTION_SESSION_ROOT
    ? join(
        process.env.FOUNDRY_EXECUTION_SESSION_ROOT,
        "skill-isolation",
        `${key}.json`,
      )
    : foundryStatePath("skill-isolation", `${key}.json`);
}
function policyIdentity(
  workspace: string,
  managed: ManagedSkillRuntime,
): string {
  return JSON.stringify({
    version: policyVersion,
    workspace,
    plugin: managed.pluginDir,
  });
}
/** Legacy native histories can contain host skill bodies. Never resume them
 * under the new policy. Keep the Foundry transcript; start clean native context.
 */
export function isolateSkillSession(
  session: AgentSession,
  workspace: string,
  managed: ManagedSkillRuntime,
): {
  session: AgentSession;
  reset: boolean;
  record: (nativeID: string) => void;
} {
  const identity = policyIdentity(workspace, managed);
  let trusted = false;
  if (session.nativeSessionId) {
    try {
      trusted =
        readFileSync(receiptPath(session.nativeSessionId), "utf8") === identity;
    } catch {
      /* legacy session */
    }
  }
  const reset = Boolean(session.nativeSessionId && !trusted);
  return {
    session: reset
      ? { ...session, nativeSessionId: undefined, importedContext: undefined }
      : session,
    reset,
    record(nativeID) {
      if (!nativeID) return;
      const path = receiptPath(nativeID);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, identity, { mode: 0o600 });
    },
  };
}
