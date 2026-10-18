/** Private endpoint windows must reach Codex's startup model registry too. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { validContextWindow } from "@bd777/foundry-protocol";
import type { SessionContextWindow } from "../context-window.js";
import { foundryStatePath } from "../state-root.js";
import { writeFileAtomic } from "../storage.js";

const exec = promisify(execFile);
type Model = Record<string, unknown> & { slug: string };

/**
 * Keep the installed CLI's instructions and capabilities. Relay aliases of a
 * known model use that model's definition; opaque ids use a conservative native
 * coding template, without claiming the endpoint supports optional tools.
 */
export function codexCatalogWithWindow(
  body: unknown,
  window: SessionContextWindow,
): { models: Model[] } {
  if (!validContextWindow(window.tokens) || !window.model.trim())
    throw new Error("Invalid Codex model context window.");
  const models = (body as { models?: Model[] } | null)?.models;
  if (
    !Array.isArray(models) ||
    !models.length ||
    models.some((row) => !row || typeof row.slug !== "string")
  )
    throw new Error("Codex returned an invalid bundled model catalog.");
  const id = window.model;
  const canonical = id.slice(id.lastIndexOf("/") + 1).toLowerCase();
  const known =
    models.find((row) => row.slug === id) ??
    models.find((row) => row.slug.toLowerCase() === canonical);
  // The template supplies the native prompt/schema, not provider capabilities.
  const template =
    known ?? models.find((row) => row.slug === "gpt-5.5") ?? models[0]!;
  const selected: Model = {
    ...template,
    ...(!known
      ? {
          model_messages: null,
          supported_reasoning_levels: [],
          default_reasoning_level: null,
          experimental_supported_tools: [],
          input_modalities: ["text"],
          supports_search_tool: false,
          supports_image_detail_original: false,
          supports_experimental_context: false,
          additional_speed_tiers: [],
          service_tiers: [],
        }
      : {}),
    slug: id,
    display_name: id,
    context_window: window.tokens,
    max_context_window: window.tokens,
    // Let the CLI derive its normal compact threshold from the new window.
    auto_compact_token_limit: null,
  };
  return { models: [selected, ...models.filter((row) => row.slug !== id)] };
}

/**
 * Load only native bundled metadata (no endpoint/account request). The registry
 * is read when app-server starts, not when thread/start config is applied.
 * Content-addressed files let concurrent models/windows share a config home
 * without replacing a catalog a starting process has not read yet.
 */
export async function codexModelCatalogArguments(
  command: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  window: SessionContextWindow | undefined,
  signal?: AbortSignal,
): Promise<string[]> {
  if (!window) return [];
  let body: unknown;
  try {
    const result = await exec(
      command,
      ["debug", "models", "--bundled", "-c", 'model_provider="openai"'],
      { env, cwd, signal, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
    );
    body = JSON.parse(result.stdout);
  } catch {
    if (signal?.aborted)
      throw new Error("Codex turn was interrupted before it started.");
    // Native diagnostics may contain URLs or credentials. Never downgrade a
    // configured window just because the native registry could not be read.
    throw new Error(
      "Cannot read Codex's bundled model definitions for the configured context window.",
    );
  }
  const contents = `${JSON.stringify(codexCatalogWithWindow(body, window))}\n`;
  const identity = createHash("sha256").update(contents).digest("hex");
  // Issue executions cannot write the device's private state. Their catalogs
  // belong to the same writable scratch root as their session artifacts.
  const scratch = env.FOUNDRY_EXECUTION_SESSION_ROOT?.trim();
  const path = scratch
    ? resolve(scratch, "codex-models", `${identity}.json`)
    : foundryStatePath("native-runtime", "codex-models", `${identity}.json`);
  let current: string | undefined;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    /* First use of this exact native catalog and resolved window. */
  }
  if (current !== contents) writeFileAtomic(path, contents);
  return ["-c", `model_catalog_json=${JSON.stringify(path)}`];
}
