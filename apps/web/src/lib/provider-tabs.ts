/**
 * The tabs of Model providers, one per kind of model access: the official
 * subscriptions, API endpoints, and connector launch environments.
 */
export const providerTabs = [
  "subscriptions",
  "endpoints",
  "environments",
] as const;

export type ProviderTab = (typeof providerTabs)[number];

/** The tab an address names; Subscriptions when it names none. */
export function providerTabFrom(value: string | undefined): ProviderTab {
  return providerTabs.find((tab) => tab === value) ?? "subscriptions";
}
