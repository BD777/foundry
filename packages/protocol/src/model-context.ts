// A model's context window on a compatible endpoint: the person's own setting,
// else what the endpoint's `/models` catalog reports, else the official model's
// window when the name shows a Claude or GPT model, else a 1M default.

/** Where a profile's model window comes from, in precedence order. */
export type ContextWindowSource =
  "setting" | "endpoint" | "official" | "default";

export interface ResolvedContextWindow {
  tokens: number;
  source: ContextWindowSource;
}

export const defaultContextWindow = 1_000_000;
export const minContextWindow = 1_000;
export const maxContextWindow = 10_000_000;

/**
 * Claude windows as Claude Code 2.1.295 catalogs them (`context.window` in the
 * model table built into the CLI; `native_1m` models are 1M). Models whose
 * 1M window is a beta opt-in (`supports_1m_beta` without `native_1m`) keep
 * their 200K default, which is what the CLI runs them with. Claude 3.x
 * entries carry no window there and are left out.
 */
const claudeWindows: Readonly<Record<string, number>> = {
  "claude-haiku-4-5": 200_000,
  "claude-haiku-5-5": 1_000_000,
  "claude-sonnet-4-0": 200_000,
  "claude-sonnet-4-5": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-sonnet-5": 1_000_000,
  "claude-sonnet-5-5": 1_000_000,
  "claude-opus-4-0": 200_000,
  "claude-opus-4-1": 200_000,
  "claude-opus-4-5": 200_000,
  "claude-opus-4-6": 200_000,
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-8": 1_000_000,
  "claude-opus-5": 1_000_000,
  "claude-opus-5-5": 1_000_000,
  "claude-fable-5": 1_000_000,
  "claude-fable-5-1": 1_000_000,
  "claude-mythos-5": 1_000_000,
  "claude-mythos-5-1": 1_000_000,
};

/** The short ids the CLI's catalog also answers to for its first Claude 4s. */
const claudeAliases: Readonly<Record<string, string>> = {
  "claude-sonnet-4": "claude-sonnet-4-0",
  "claude-opus-4": "claude-opus-4-0",
};

/**
 * GPT windows as Codex 0.153.4 ships them (its bundled `models.json`,
 * `max_context_window`: the largest window Codex lets the model run with;
 * `context_window` is only its default).
 */
const gptWindows: Readonly<Record<string, number>> = {
  "gpt-6-astra": 872_000,
  "gpt-5.6-sol": 872_000,
  "gpt-5.6-terra": 872_000,
  "gpt-5.6-luna": 872_000,
  "gpt-5.5": 272_000,
  "gpt-5.4": 1_000_000,
  "gpt-5.4-mini": 272_000,
  "gpt-5.2": 272_000,
};

/**
 * The model's own id inside a relay's name: the last path segment, without a
 * region or vendor prefix (`us.anthropic.`), Claude Code's `[1m]` suffix, or a
 * release-date / version suffix.
 */
function canonicalModelId(model: string): string {
  let id = model
    .trim()
    .toLowerCase()
    .replace(/\[1m\]/g, "");
  id = id.slice(id.lastIndexOf("/") + 1);
  const vendor = id.lastIndexOf("anthropic.");
  if (vendor >= 0) id = id.slice(vendor + "anthropic.".length);
  return id
    .replace(/-v\d+(:\d+)?$/, "")
    .replace(/@\d{8}$/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "")
    .replace(/-latest$/, "");
}

/**
 * Claude models whose 1M window Claude Code 2.1.295 runs only as an opt-in
 * (`supports_1m_beta` without `native_1m` in its model table): named
 * `<model>[1m]`, the CLI sends the plain name with the `context-1m-2025-08-07`
 * beta and counts a 1M window.
 */
const claudeOneMillionOptIns = new Set([
  "claude-sonnet-4-0",
  "claude-sonnet-4-5",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
]);

/** The Claude Code catalog id a Claude model name stands for. */
function claudeCatalogId(model: string): string | undefined {
  const id = canonicalModelId(model);
  if (!id.startsWith("claude-")) return undefined;
  // OpenRouter-style names write versions with dots (claude-sonnet-4.5).
  const claude = id.replace(/(\d)\.(\d)/g, "$1-$2");
  return claudeAliases[claude] ?? claude;
}

/** The official window of a Claude or GPT model named in `model`, if sourced. */
export function officialContextWindow(model: string): number | undefined {
  const claude = claudeCatalogId(model);
  if (claude) return claudeWindows[claude];
  const id = canonicalModelId(model);
  return id.startsWith("gpt-") ? gptWindows[id] : undefined;
}

/** True when Claude Code runs this model at 1M only through `[1m]`. */
export function claudeOneMillionOptIn(model: string): boolean {
  const claude = claudeCatalogId(model);
  return !!claude && claudeOneMillionOptIns.has(claude);
}

/** The model name without Claude Code's `[1m]` opt-in suffix. */
export function withoutOneMillionSuffix(model: string): string {
  return model.replace(/\[1m\]/gi, "");
}

/** True when Claude Code forces a 1M window for this name (`[1m]` opt-in). */
export function claudeOneMillionSuffix(model: string): boolean {
  return /\[1m\]/i.test(model);
}

export function resolveContextWindow(
  model: string,
  known: { setting?: number; endpoint?: number } = {},
): ResolvedContextWindow {
  if (validContextWindow(known.setting))
    return { tokens: known.setting, source: "setting" };
  if (validContextWindow(known.endpoint))
    return { tokens: known.endpoint, source: "endpoint" };
  const official = officialContextWindow(model);
  if (official) return { tokens: official, source: "official" };
  return { tokens: defaultContextWindow, source: "default" };
}

export function validContextWindow(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minContextWindow &&
    value <= maxContextWindow
  );
}

/**
 * A window typed by a person: `200000`, `200k`, `1m`, `1.5M`, with optional
 * separators. Undefined when it is not a whole token count in range.
 */
export function parseContextWindow(text: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(
    text.trim().replace(/[,_\s]/g, ""),
  );
  if (!match) return undefined;
  const unit = match[2]?.toLowerCase();
  const value = Math.round(
    Number(match[1]) * (unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1),
  );
  return validContextWindow(value) ? value : undefined;
}

/** Only the in-range entries of a stored per-model map, keys trimmed. */
export function cleanContextWindows(
  windows: Record<string, unknown> | undefined,
): Record<string, number> {
  const clean: Record<string, number> = {};
  for (const [model, tokens] of Object.entries(windows ?? {})) {
    const id = model.trim();
    if (id && validContextWindow(tokens)) clean[id] = tokens;
  }
  return clean;
}
