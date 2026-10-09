/** Workspace skill discovery policy, shared by SDK and CLI execution. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ManagedSkillRuntime } from "./skill-materializer.js";
import { foundryStatePath } from "./state-root.js";
import { writePrivateTextAtomic } from "./storage.js";
import { withCodexControl } from "./native-inspection.js";
import { hasProgram, skillToolRequirements } from "./skill-requirements.js";
import { withManagedTools } from "./managed-tools.js";

/**
 * Names the programs the session's skills run that this device lacks, so the
 * agent tells the person rather than working around a missing tool.
 */
function missingProgramsNote(managed: ManagedSkillRuntime): string[] {
  const missing = managed.skills.flatMap((skill) => {
    let tools: string[];
    try {
      tools = skillToolRequirements(skill.dir);
    } catch {
      return [];
    }
    const env = { ...process.env, PATH: withManagedTools(process.env.PATH) };
    const absent = tools.filter((tool) => !hasProgram(tool, env));
    return absent.length ? [`${skill.name} needs ${absent.join(", ")}`] : [];
  });
  return missing.length
    ? [
        `Programs these skills run are missing on this device: ${missing.join("; ")}. When a task needs one, tell the person it must be installed on this device instead of working around it.`,
      ]
    : [];
}

/** A workspace skill replaces the agent's own skill of the same name. */
function replacedByWorkspace(
  managed: ManagedSkillRuntime,
): (name: string) => boolean {
  const names = new Set(
    managed.skills.map((skill) => skill.name.toLowerCase()),
  );
  return (name) => names.has(name.toLowerCase());
}

export function workspaceSkillInstructions(
  managed: ManagedSkillRuntime,
): string {
  const replaced = replacedByWorkspace(managed);
  return [
    "Foundry workspace skill policy: the following is the complete allowed skill catalog for this workspace session.",
    "Use only these managed copies and this agent's own built-in skills (marked builtIn), including when a user names a skill or a skill references another skill. Do not discover, read, or invoke skills from device-local installations, plugins, other workspaces, or earlier conversation context. If a requested skill is absent, say it must be promoted and selected for this workspace first. Ordinary project source files remain available.",
    "To create a skill or change one of these, work on a copy in this workspace's .agents/skills/<name>/ folder (copy the listed folder there first when changing an existing skill); never edit the listed copies. The person then publishes it from Foundry as a new skill or as a new version of the existing one.",
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
    ...missingProgramsNote(managed),
    "When a built-in skill shares its name with one of the workspace skills above, the workspace skill replaces it: use the workspace skill.",
    ...(managed.officialSkills ?? [])
      .filter((skill) => !replaced(skill.name))
      .map((skill) =>
        JSON.stringify({
          name: skill.name,
          description: skill.description ?? "",
          builtIn: true,
          ...(skill.path ? { file: skill.path } : {}),
        }),
      ),
  ].join("\n");
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
  if (
    !managed.skills.some((skill) => skill.name === unqualified) &&
    !managed.officialSkills?.some((skill) => skill.name === name)
  ) {
    throw new Error(
      `Skill "${name}" is not configured for this workspace. Promote it and select it in Workspace Skills first.`,
    );
  }
}

/** Use the native inventory, including custom CODEX_HOME, .agents, ancestors,
 * admin and plugin roots. No package content scans or model requests are needed.
 * Config rules select existing skills; they do NOT mount additional paths.
 * Disable native skills by document path and supply only our verified catalog,
 * except Codex's own (scope "system"), which stay.
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
      const skills = entry.skills as Array<{
        name: string;
        description?: string;
        path: string;
        scope?: string;
      }>;
      for (const skill of skills)
        if (typeof skill.path !== "string" || !skill.path.startsWith("/"))
          throw new Error("Native Codex returned an invalid skill path.");
      // A workspace skill replaces Codex's own skill of the same name.
      const replaced = replacedByWorkspace(managed);
      const official = (skill: { name: string; scope?: string }) =>
        skill.scope === "system" && !replaced(skill.name);
      return {
        host: skills.filter((skill) => !official(skill)),
        official: skills.filter(official),
      };
    },
    { cwd, env, args: [] },
  );
  return {
    ...managed,
    hostSkillPaths: [
      ...new Set<string>(paths.host.map((skill) => skill.path)),
    ].sort(),
    officialSkills: paths.official.map(({ name, description, path }) => ({
      name,
      description,
      path,
    })),
  };
}

/**
 * A receipt records that a native session ran under Foundry's workspace
 * skill policy, and in which workspace folder. The skill catalog is not part
 * of it: a session told a different catalog next turn keeps its native
 * conversation, and the policy above tells it to ignore skills mentioned
 * earlier in that conversation.
 */
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
function readReceipt(
  nativeID: string,
): { version?: unknown; workspace?: unknown } | undefined {
  try {
    return JSON.parse(readFileSync(receiptPath(nativeID), "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Whether a native session's receipt says it belongs elsewhere: another
 * workspace folder, or a policy that must not carry over. A missing receipt
 * (a session started outside Foundry, or before receipts) conflicts with
 * nothing.
 */
export function skillReceiptConflicts(
  nativeID: string,
  workspace: string,
): boolean {
  const receipt = readReceipt(nativeID);
  return Boolean(
    receipt &&
    (receipt.version !== policyVersion || receipt.workspace !== workspace),
  );
}

/**
 * Records that the native session runs under the policy in this workspace.
 * Called for every message of a run: it writes once, and atomically, so a
 * worker killed mid-run never leaves an empty receipt.
 */
export function recordSkillReceipt(nativeID: string, workspace: string): void {
  if (!nativeID) return;
  const receipt = readReceipt(nativeID);
  if (receipt?.version === policyVersion && receipt.workspace === workspace)
    return;
  writePrivateTextAtomic(
    receiptPath(nativeID),
    JSON.stringify({ version: policyVersion, workspace }),
  );
}
