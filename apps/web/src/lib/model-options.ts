import type { AgentModelOption } from "@bd777/foundry-protocol";

/**
 * The models a run may pick: the profile's configured list first, then anything
 * a native CLI discovered. The profile's list leads because a person curated
 * it, and duplicates collapse so one model never appears twice in a picker.
 */
export function mergeModelOptionLists(
  configured: string[],
  discovered: AgentModelOption[],
): AgentModelOption[] {
  // A discovered entry describes its model (label, efforts), so it stays
  // whole even when the curated list names the same model.
  const discoveredById = new Map<string, AgentModelOption>();
  for (const option of discovered) {
    const id = option.id.trim();
    if (id && !discoveredById.has(id)) discoveredById.set(id, option);
  }
  const options: AgentModelOption[] = [];
  const seen = new Set<string>();
  for (const model of configured) {
    const id = model.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    options.push(discoveredById.get(id) ?? { id });
  }
  for (const [id, option] of discoveredById) {
    if (seen.has(id)) continue;
    seen.add(id);
    options.push(option);
  }
  return options;
}
