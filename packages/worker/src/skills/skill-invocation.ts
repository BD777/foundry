import { join } from "node:path";
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

/** Codex's own input for invoking a skill (its app server's `skill` item). */
export interface CodexSkillInput {
  type: "skill";
  name: string;
  path: string;
}

/**
 * A Codex prompt that opens with a selected skill: the skill as Codex's
 * structured skill input, and the rest as text. A typed `$name` is only text
 * to Codex's app server, and a skill meant for explicit use only
 * (`allow_implicit_invocation: false`) is not in the model's list at all.
 * Drafts are not linked into Codex's skill folder, so they stay as typed.
 */
export function codexManagedInput(
  prompt: string,
  managed: ManagedSkillRuntime | undefined,
): { text: string; skill?: CodexSkillInput } {
  const invocation = leadingSkillInvocation(prompt, managed);
  if (!invocation || invocation.skill.draft) return { text: prompt };
  return {
    text: invocation.rest.trimStart(),
    skill: {
      type: "skill",
      name: invocation.skill.name,
      path: join(invocation.skill.dir, "SKILL.md"),
    },
  };
}
