import type { AgentModelOption } from "@bd777/foundry-protocol";

const catalogURL = "https://developers.openai.com/codex/models";

/** Read only published model cards, never examples, retired models or API navigation. */
export function publishedCodexModels(html: string): AgentModelOption[] {
  const ids = new Set<string>();
  for (const match of html.matchAll(
    /\bdata-model-slug=["']([a-z0-9][a-z0-9.-]*)["']/g,
  )) {
    ids.add(match[1]!);
  }
  return [...ids].map((id) => ({ id }));
}

/** Public documentation metadata: no credentials and no inference request. */
export async function withPublishedCodexModels(
  readNative: () => Promise<AgentModelOption[]>,
  fetchCatalog: typeof fetch = fetch,
): Promise<AgentModelOption[]> {
  const [published, native] = await Promise.allSettled([
    (async () => {
      const response = await fetchCatalog(catalogURL, {
        signal: AbortSignal.timeout(8000),
        credentials: "omit",
      });
      if (!response.ok) throw new Error("Published Codex catalog unavailable.");
      const models = publishedCodexModels(await response.text());
      if (!models.length)
        throw new Error("Published Codex catalog contains no model cards.");
      return models;
    })(),
    readNative(),
  ]);
  if (published.status === "rejected" && native.status === "rejected") {
    throw new Error(
      "Could not read the published or native Codex model catalog. Retry.",
    );
  }
  const nativeModels = native.status === "fulfilled" ? native.value : [];
  const options = new Map(nativeModels.map((model) => [model.id, model]));
  // Published models lead; retain native labels and account-specific/older choices.
  const merged = new Map<string, AgentModelOption>();
  for (const model of published.status === "fulfilled" ? published.value : []) {
    merged.set(model.id, options.get(model.id) ?? model);
  }
  for (const model of nativeModels) merged.set(model.id, model);
  return [...merged.values()];
}
