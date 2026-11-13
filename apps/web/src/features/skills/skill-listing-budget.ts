/**
 * How much of a session's Skill list Claude Code shows with descriptions.
 *
 * Claude Code puts every Skill it can use into one listing in the session's
 * context, sized to a budget (read from Claude Code 2.1.311): the model's
 * context window × its bytes per token × 1% (`skillListingBudgetFraction`),
 * measured in display width (a CJK character counts 2). The listings of
 * Claude Opus 5.5 and Haiku 5.5 sessions on dev filled 29,981 of a 30,000
 * budget (1M tokens × 3 × 1%), so that is the budget used here. An entry is
 * `- name: description` with the description cut to 1,536 characters. When the
 * full listing is over budget, every entry first becomes `- name`, Claude
 * Code's bundled Skills keep their descriptions, and the rest get theirs back
 * in its own priority order while they fit. This estimate adds the narrowest
 * descriptions first, so its count is the fewest that can lose theirs.
 */

export const claudeSkillListingBudget = 30_000;

export interface ListedSkill {
  name: string;
  description?: string;
  /** One of Claude Code's own Skills: always listed with its description. */
  bundled?: boolean;
}

export interface SkillListingEstimate {
  entries: number;
  budget: number;
  fullWidth: number;
  /** Skills listed by name only, at the least. */
  withoutDescriptions: number;
}

const maxDescriptionChars = 1536;

/** Display width: East Asian wide and fullwidth characters count 2. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      code >= 0x1f300;
    width += wide ? 2 : 1;
  }
  return width;
}

export function claudeSkillListing(
  skills: ListedSkill[],
  budget = claudeSkillListingBudget,
): SkillListingEstimate {
  const separators = Math.max(0, skills.length - 1);
  const entries = skills.map((skill) => {
    const nameOnly = displayWidth(`- ${skill.name}`);
    const description = [...(skill.description ?? "")]
      .slice(0, maxDescriptionChars)
      .join("");
    const full = description
      ? nameOnly + 2 + displayWidth(description)
      : nameOnly;
    return { nameOnly, full, bundled: skill.bundled === true };
  });
  const fullWidth =
    entries.reduce((sum, entry) => sum + entry.full, 0) + separators;
  const estimate = { entries: skills.length, budget, fullWidth };
  if (fullWidth <= budget) return { ...estimate, withoutDescriptions: 0 };
  let left =
    budget -
    entries.reduce(
      (sum, entry) => sum + (entry.bundled ? entry.full : entry.nameOnly),
      0,
    ) -
    separators;
  let withoutDescriptions = 0;
  const extras = entries
    .filter((entry) => !entry.bundled && entry.full > entry.nameOnly)
    .map((entry) => entry.full - entry.nameOnly)
    .sort((a, b) => a - b);
  for (const extra of extras) {
    if (extra <= left) left -= extra;
    else withoutDescriptions += 1;
  }
  return { ...estimate, withoutDescriptions };
}
