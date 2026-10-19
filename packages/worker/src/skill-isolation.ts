/** Workspace skill discovery policy, shared by SDK and CLI execution. */
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  skillCatalogEntry,
  type ManagedSkillRuntime,
} from "./skill-materializer.js";
import { foundryStatePath } from "./state-root.js";
import { tryReadJSONFile, writeFileAtomic } from "./storage.js";
import { withCodexControl } from "./native-inspection.js";
import { hasProgram, skillToolRequirements } from "./skill-requirements.js";
import { withManagedTools } from "./managed-tools.js";

/** Skill names shown per missing program before "and N more". */
const namesPerProgram = 5;

/**
 * Names the programs the session's skills run that this device lacks, so the
 * agent tells the person rather than working around a missing tool. One line
 * per program, however many skills need it.
 */
function missingProgramsNote(managed: ManagedSkillRuntime): string[] {
  const env = { ...process.env, PATH: withManagedTools(process.env.PATH) };
  const present = new Map<string, boolean>();
  const neededBy = new Map<string, string[]>();
  for (const skill of managed.skills) {
    let tools: string[];
    try {
      tools = skillToolRequirements(skill.dir);
    } catch {
      continue;
    }
    for (const tool of tools) {
      if (!present.has(tool)) present.set(tool, hasProgram(tool, env));
      if (!present.get(tool))
        neededBy.set(tool, [...(neededBy.get(tool) ?? []), skill.name]);
    }
  }
  const missing = [...neededBy].map(([tool, names]) => {
    const shown = names.slice(0, namesPerProgram).join(", ");
    const more = names.length - namesPerProgram;
    return `${tool} (needed by ${shown}${more > 0 ? ` and ${more} more` : ""})`;
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
  const names = new Set([
    ...managed.skills.map((skill) => skill.name.toLowerCase()),
    ...(managed.excludedNames ?? []).map((name) => name.toLowerCase()),
  ]);
  return (name) => names.has(name.toLowerCase());
}

export function workspaceSkillInstructions(
  managed: ManagedSkillRuntime,
): string {
  const replaced = replacedByWorkspace(managed);
  const indexes = managed.indexes ?? [];
  const indexed = new Set(indexes.flatMap((index) => index.skills));
  return [
    "Foundry workspace skill policy: the following is the complete allowed skill catalog for this workspace session.",
    ...(managed.skills.some((skill) => skill.draft) || managed.excludedNames
      ? [
          "For Skill trials use Foundry create_session with skillSelection and fresh native history. Native internal subagents are disabled until their Skill isolation can be independently verified. Use include with an exact draft id/digest for with_skill, library revisions for old_skill, and exclude with the same draft reference for without_skill. Never carry the method text into the baseline prompt or imported context.",
        ]
      : []),
    ...(managed.draftsEnabled
      ? [
          "Workspace drafts are enabled. After creating or editing .agents/skills/<name>/, call refresh_workspace_skills to obtain a trusted immutable snapshot. You may read and trial the returned snapshots in this turn; native Skill registration updates on a later safe turn. Publication is a separate action, not a prerequisite for trial. Use draft:name for a draft that shares a library or built-in name.",
        ]
      : []),
    "Use only these managed copies and this agent's own built-in skills (marked builtIn), including when a user names a skill or a skill references another skill. Do not discover, read, or invoke skills from device-local installations, plugins, other workspaces, or earlier conversation context. If a requested skill is absent, use refresh_workspace_skills when drafts are enabled; otherwise it must be promoted and selected for this workspace. Ordinary project source files remain available.",
    "To create a skill or change one of these, work on a copy in this workspace's .agents/skills/<name>/ folder (copy the listed folder there first when changing an existing skill); never edit the listed copies. The person then publishes it from Foundry as a new skill or as a new version of the existing one.",
    ...(indexes.length
      ? [
          "An entry with an index stands for many skills, all of them in the catalog: a large bundle, or the skills past those listed one by one. When a task may need one of them, or the person names a skill not listed one by one, read the index, which gives each skill's name, purpose and SKILL.md, then open that SKILL.md.",
        ]
      : []),
    ...managed.skills
      .filter((skill) => !indexed.has(skill.name))
      .map(skillCatalogEntry),
    ...indexes.map((index) =>
      JSON.stringify({
        [index.bundleId ? "bundle" : "group"]: index.name,
        ...(index.version ? { version: index.version } : {}),
        description: (index.description ?? "").slice(0, 300),
        skills: index.skills.length,
        index: index.file,
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
  return prompt.replace(/^\s*\/([\w:-]+)(?=\s|$)/, (match, name: string) => {
    const skill = managed.skills.find(
      (skill) =>
        skill.name === name ||
        skill.invocationName === name ||
        skill.aliases?.includes(name),
    );
    return skill ? `/foundry-workspace:${skill.name}` : match;
  });
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
    managed.excludedNames?.includes(unqualified) &&
    !managed.skills.some((s) => s.invocationName === name)
  )
    throw new Error(`Skill "${name}" is excluded from this trial.`);
  if (
    !managed.skills.some(
      (skill) =>
        skill.name === unqualified ||
        skill.invocationName === unqualified ||
        skill.aliases?.includes(unqualified),
    ) &&
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
  signal?: AbortSignal,
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
    { cwd, env, args: [], signal },
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
  return tryReadJSONFile(receiptPath(nativeID));
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
  writeFileAtomic(
    receiptPath(nativeID),
    JSON.stringify({ version: policyVersion, workspace }),
  );
}

/**
 * A workspace's folder moved: a native session whose receipt names the old
 * folder belongs to the new one now, so resuming it there is no conflict.
 * Returns whether the receipt was moved.
 */
export function moveSkillReceipt(
  nativeID: string,
  fromWorkspace: string,
  toWorkspace: string,
): boolean {
  const receipt = readReceipt(nativeID);
  if (!receipt || receipt.workspace !== fromWorkspace) return false;
  writeFileAtomic(
    receiptPath(nativeID),
    JSON.stringify({ ...receipt, workspace: toWorkspace }),
  );
  return true;
}
