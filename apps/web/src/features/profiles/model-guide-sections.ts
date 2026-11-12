import type { ModelGuideSections } from "@bd777/foundry-protocol";

export const modelGuideSectionKeys = [
  "summary",
  "strengths",
  "weaknesses",
  "briefing",
  "avoid",
  "pitfalls",
  "settings",
] as const satisfies readonly (keyof ModelGuideSections)[];
