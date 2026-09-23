import type { AgentModelOption } from "@foundry/protocol";

/**
 * The models a run may pick: the profile's configured list first, then anything
 * a native CLI discovered. The profile's list leads because a person curated
 * it, and duplicates collapse so one model never appears twice in a picker.
 */
export function mergeModelOptionLists(
  configured: string[],
  discovered: AgentModelOption[],
): AgentModelOption[] {
  const options: AgentModelOption[] = [];
  const seen = new Set<string>();
  for (const model of configured) {
    const id = model.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    options.push({ id });
  }
  for (const option of discovered) {
    const id = option.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    options.push(option);
  }
  return options;
}
