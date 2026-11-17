import type {
  ManagedSkill,
  ManagedSkillRuntime,
} from "./skill-materializer.js";

const leadingCommand = /^\s*\/([\w:-]+)(?=\s|$)/;

/**
 * The selected skill a prompt's leading `/name` invokes, and the rest of the
 * prompt. A name is the skill's name, its invocation name or an alias.
 */
export function leadingSkillInvocation(
  prompt: string,
  managed: ManagedSkillRuntime | undefined,
): { skill: ManagedSkill; rest: string } | undefined {
  const match = leadingCommand.exec(prompt);
  const name = match?.[1];
  if (!match || !name || !managed) return undefined;
  const skill = managed.skills.find(
    (skill) =>
      skill.name === name ||
      skill.invocationName === name ||
      skill.aliases?.includes(name),
  );
  return skill ? { skill, rest: prompt.slice(match[0].length) } : undefined;
}

/**
 * Claude Code namespaces plugin skills: `/name` typed for a workspace skill
 * becomes `/foundry-workspace:name`. Any other command is left to Claude Code.
 */
export function claudeManagedPrompt(
  prompt: string,
  managed: ManagedSkillRuntime | undefined,
): string {
  const invocation = leadingSkillInvocation(prompt, managed);
  if (!invocation) return prompt;
  return `/foundry-workspace:${invocation.skill.name}${invocation.rest}`;
}

/**
 * Codex loads a skill named in its text as `$name` (a plain `/name` is only
 * text to it). Drafts are not linked into Codex's skill folder, so they stay
 * as typed.
 */
export function codexManagedPrompt(
  prompt: string,
  managed: ManagedSkillRuntime | undefined,
): string {
  const invocation = leadingSkillInvocation(prompt, managed);
  if (!invocation || invocation.skill.draft) return prompt;
  return `$${invocation.skill.name}${invocation.rest}`;
}
