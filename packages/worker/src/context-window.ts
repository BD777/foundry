/**
 * The context window a server profile's compatible endpoint runs a model
 * with (rules in protocol model-context.ts), and how each CLI is told:
 *
 * - Claude Code 2.1.295 takes `CLAUDE_CODE_MAX_CONTEXT_TOKENS` as the window
 *   of a model it does not recognize (otherwise it assumes 200K). For a model
 *   in its own catalog the variable is ignored and the catalog window holds;
 *   a model whose 1M window is an opt-in runs at 1M when named `<model>[1m]`
 *   (the CLI then sends the plain name plus the `context-1m-2025-08-07` beta).
 *   A smaller window can only cap auto-compact, through
 *   `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (min of the two). Checked by running
 *   the CLI against a local mock endpoint and reading
 *   `modelUsage.contextWindow` and the request it sent.
 * - Codex 0.153.4 takes `model_context_window`, capped at the model's
 *   `max_context_window` (272K for a model it does not know) and reported as
 *   95% usable; auto-compact follows the window without
 *   `model_auto_compact_token_limit`. Checked the same way, from the
 *   rollout's `token_count` records.
 */
import { createHash } from "node:crypto";
import {
  claudeOneMillionOptIn,
  claudeOneMillionSuffix,
  officialContextWindow,
  resolveContextWindow,
  type AgentModelOption,
  type AgentSession,
  type ConfiguredContextWindow,
} from "@bd777/foundry-protocol";
import type { AgentProfileLocalConfig } from "./profiles.js";
import { listEndpointModels } from "./models.js";

export interface SessionContextWindow extends ConfiguredContextWindow {
  /** The model it was resolved for. */
  model: string;
}

type CatalogReader = (
  profile: AgentProfileLocalConfig,
) => Promise<AgentModelOption[]>;

const catalogFresh = 10 * 60_000;
/** A run waits this long for the catalog before falling through. */
const catalogTimeoutMs = 5000;
const catalogs = new Map<
  string,
  { expiresAt: number; models: Promise<AgentModelOption[]> }
>();

/** Only server profiles calling a compatible endpoint get a window. */
function appliesTo(profile: AgentProfileLocalConfig): boolean {
  return (
    profile.origin === "server" &&
    !!profile.baseUrl?.trim() &&
    (profile.connectionType === "anthropic_compatible" ||
      profile.connectionType === "openai_compatible")
  );
}

/**
 * The endpoint's catalog, read at most once per ten minutes per endpoint and
 * credential. A failed read is not kept, and costs the run no more than the
 * timeout: the window then falls through to the official model or default.
 */
function readCatalog(
  profile: AgentProfileLocalConfig,
): Promise<AgentModelOption[]> {
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        profile.connectionType,
        profile.baseUrl?.trim(),
        profile.apiKey?.trim() ?? "",
      ]),
    )
    .digest("hex");
  const cached = catalogs.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.models;
  const models = listEndpointModels(
    profile,
    profile.baseUrl!.trim(),
    catalogTimeoutMs,
  );
  catalogs.set(key, { expiresAt: Date.now() + catalogFresh, models });
  models.catch(() => {
    if (catalogs.get(key)?.models === models) catalogs.delete(key);
  });
  return models;
}

export async function resolveSessionContextWindow(
  profile: AgentProfileLocalConfig,
  model: string,
  catalog: CatalogReader = readCatalog,
): Promise<SessionContextWindow | undefined> {
  const id = model.trim();
  if (!id || !appliesTo(profile)) return undefined;
  const setting = profile.contextWindows?.[id];
  let endpoint: number | undefined;
  if (setting === undefined) {
    try {
      endpoint = (await catalog(profile)).find(
        (option) => option.id === id,
      )?.contextWindow;
    } catch {
      // An endpoint without a readable catalog reports no window.
    }
  }
  return { ...resolveContextWindow(id, { setting, endpoint }), model: id };
}

/** The profile with the window this session's model runs with. */
export async function withSessionContextWindow(
  profile: AgentProfileLocalConfig,
  session: AgentSession,
  catalog?: CatalogReader,
): Promise<AgentProfileLocalConfig> {
  const model = session.model?.trim() || profile.model?.trim() || "";
  const contextWindow = await resolveSessionContextWindow(
    profile,
    model,
    catalog,
  );
  return contextWindow ? { ...profile, contextWindow } : profile;
}

/** The window Claude Code itself runs a model with, when it knows the model. */
function claudeCodeOwnWindow(model: string): number | undefined {
  if (claudeOneMillionSuffix(model)) return 1_000_000;
  return /(^|[/.])claude-/i.test(model)
    ? officialContextWindow(model)
    : undefined;
}

/**
 * The model name Claude Code is started with: `<model>[1m]` when the window
 * resolved for it is 1M or more and Claude Code runs it at 1M only on that
 * opt-in, else the name as chosen. Foundry shows and records the plain name.
 */
export function claudeRunModel(
  profile: AgentProfileLocalConfig,
  model: string,
): string {
  const window = profile.contextWindow;
  return window?.model === model &&
    window.tokens >= 1_000_000 &&
    !claudeOneMillionSuffix(model) &&
    claudeOneMillionOptIn(model)
    ? `${model}[1m]`
    : model;
}

export function claudeContextWindowEnvironment(
  window: SessionContextWindow,
): Record<string, string> {
  const env: Record<string, string> = {
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(window.tokens),
  };
  const own = claudeCodeOwnWindow(window.model);
  if (own !== undefined && window.tokens < own)
    env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(window.tokens);
  return env;
}

export function codexContextWindowConfig(
  window: SessionContextWindow,
): Record<string, unknown> {
  return { model_context_window: window.tokens };
}

/** What a context report says about the configured window. */
export function configuredWindow(
  window: SessionContextWindow | undefined,
): ConfiguredContextWindow | undefined {
  return window ? { tokens: window.tokens, source: window.source } : undefined;
}
