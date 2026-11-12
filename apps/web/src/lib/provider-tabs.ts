/**
 * The sections of Model providers, grouped as the menu shows them: how agents
 * run (the default execution model, worker groups, model guides), then one
 * section per kind of model access (the official subscriptions, API endpoints,
 * connector launch environments).
 */
export const providerTabGroups = [
  { id: "execution", tabs: ["default", "groups", "guides"] },
  { id: "sources", tabs: ["subscriptions", "endpoints", "environments"] },
] as const;

export type ProviderTabGroup = (typeof providerTabGroups)[number];

export type ProviderTab = ProviderTabGroup["tabs"][number];

/** Every section, in menu order. */
export const providerTabs: readonly ProviderTab[] = providerTabGroups.flatMap(
  (group) => group.tabs,
);

/** The sections that list providers, which the runtime and device filters narrow. */
export const filteredProviderTabs: readonly ProviderTab[] =
  providerTabGroups[1].tabs;

/** The section an address names; the default execution model when it names none. */
export function providerTabFrom(value: string | undefined): ProviderTab {
  return providerTabs.find((tab) => tab === value) ?? "default";
}
