/** Private endpoint windows must reach Codex's startup model registry too. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { promisify } from "node:util";
import { validContextWindow } from "@bd777/foundry-protocol";
import type { SessionContextWindow } from "../context-window.js";
import { SingleFlight } from "../../platform/single-flight.js";
import { foundryStatePath } from "../../platform/state-root.js";
import { writeFileAtomic } from "../../platform/storage.js";

const exec = promisify(execFile);
type Model = Record<string, unknown> & { slug: string };
type BundledCatalog = { models: Model[] };
type ExecutableIdentity = { key: string };

const bundledCatalogTimeoutMs = 60_000;
const bundledCatalogFlights = new SingleFlight<BundledCatalog>();
const bundledCatalogMemory = new Map<string, BundledCatalog>();

function bundleModels(body: unknown): Model[] {
  const models = (body as { models?: Model[] } | null)?.models;
  if (
    !Array.isArray(models) ||
    !models.length ||
    models.some((row) => !row || typeof row.slug !== "string")
  )
    throw new Error("Codex returned an invalid bundled model catalog.");
  return models;
}

function parseBundledCatalog(body: unknown): BundledCatalog {
  return { models: bundleModels(body) };
}

/**
 * Identity covers the resolved program rather than a launcher symlink. A
 * replacement, in-place update, or touch invalidates the parsed catalog.
 */
function executableIdentity(
  command: string,
  env: NodeJS.ProcessEnv,
): ExecutableIdentity | undefined {
  try {
    const candidate = command.includes("/")
      ? resolve(command)
      : (env.PATH ?? "")
          .split(delimiter)
          .filter(Boolean)
          .map((directory) => resolve(directory, command))
          .find((path) => {
            try {
              return statSync(path).isFile();
            } catch {
              return false;
            }
          });
    if (!candidate) return undefined;
    const program = realpathSync.native(candidate);
    const stat = statSync(program, { bigint: true });
    const identity = [program, stat.size, stat.mtimeNs].join("\0");
    return {
      key: createHash("sha256").update(identity).digest("hex"),
    };
  } catch {
    return undefined;
  }
}

function bundledCatalogPath(identity: ExecutableIdentity): string {
  return foundryStatePath(
    "native-runtime",
    "codex-models",
    `bundled-${identity.key}.json`,
  );
}

function readDiskBundledCatalog(
  identity: ExecutableIdentity,
): BundledCatalog | undefined {
  try {
    return parseBundledCatalog(
      JSON.parse(readFileSync(bundledCatalogPath(identity), "utf8")),
    );
  } catch {
    return undefined;
  }
}

function rememberBundledCatalog(
  identity: ExecutableIdentity,
  catalog: BundledCatalog,
  env: NodeJS.ProcessEnv,
): void {
  bundledCatalogMemory.set(identity.key, catalog);
  // Issue executors may read the shared cache but cannot write device state.
  if (env.FOUNDRY_EXECUTION_SESSION_ROOT?.trim()) return;
  try {
    writeFileAtomic(
      bundledCatalogPath(identity),
      `${JSON.stringify(catalog)}\n`,
      { fsync: false },
    );
  } catch {
    // A cache write failure must not make an otherwise valid native catalog
    // unavailable to this process.
  }
}

function catalogReadFailure(error: unknown): string {
  const value = error as {
    code?: unknown;
    killed?: unknown;
    signal?: unknown;
  };
  if (
    value?.code === "ETIMEDOUT" ||
    (value?.killed === true && value?.signal === "SIGTERM")
  )
    return "timeout";
  if (typeof value?.code === "number") return `exit code ${value.code}`;
  if (typeof value?.signal === "string") return `signal ${value.signal}`;
  if (typeof value?.code === "string") return `spawn failure ${value.code}`;
  return "execution failure";
}

async function readNativeBundledCatalog(
  command: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  signal?: AbortSignal,
): Promise<BundledCatalog> {
  const configuredTimeout = Number(env.FOUNDRY_CODEX_MODEL_CATALOG_TIMEOUT_MS);
  const timeout =
    Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? configuredTimeout
      : bundledCatalogTimeoutMs;
  let failure = "execution failure";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted)
      throw new Error("Codex turn was interrupted before it started.");
    try {
      const result = await exec(
        command,
        ["debug", "models", "--bundled", "-c", 'model_provider="openai"'],
        { env, cwd, signal, timeout, maxBuffer: 4 * 1024 * 1024 },
      );
      try {
        return parseBundledCatalog(JSON.parse(result.stdout));
      } catch {
        failure = "invalid JSON";
      }
    } catch (error) {
      if (signal?.aborted)
        throw new Error("Codex turn was interrupted before it started.");
      failure = catalogReadFailure(error);
    }
  }
  // Native diagnostics may contain URLs or credentials. Log and report only
  // the stable failure class, never the command's stdout or stderr.
  console.error(
    `[codex-model-catalog] bundled catalog read failed: ${failure}`,
  );
  throw new Error(
    `Cannot read Codex's bundled model definitions for the configured context window (${failure}).`,
  );
}

async function loadBundledCatalog(
  command: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  signal?: AbortSignal,
): Promise<BundledCatalog> {
  const identity = executableIdentity(command, env);
  if (!identity)
    return bundledCatalogFlights.run(
      `unidentified:${command}\0${env.PATH ?? ""}`,
      () => readNativeBundledCatalog(command, env, cwd, signal),
    );
  const memory = bundledCatalogMemory.get(identity.key);
  if (memory) return memory;
  const disk = readDiskBundledCatalog(identity);
  if (disk) {
    bundledCatalogMemory.set(identity.key, disk);
    return disk;
  }
  return bundledCatalogFlights.run(identity.key, async () => {
    // Another caller may have completed between this call's cache lookup and
    // joining the single-flight task.
    const currentMemory = bundledCatalogMemory.get(identity.key);
    if (currentMemory) return currentMemory;
    const currentDisk = readDiskBundledCatalog(identity);
    if (currentDisk) {
      bundledCatalogMemory.set(identity.key, currentDisk);
      return currentDisk;
    }
    const catalog = await readNativeBundledCatalog(command, env, cwd, signal);
    rememberBundledCatalog(identity, catalog, env);
    return catalog;
  });
}

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
  const models = bundleModels(body);
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
  const body = await loadBundledCatalog(command, env, cwd, signal);
  const contents = `${JSON.stringify(codexCatalogWithWindow(body, window))}\n`;
  const contentIdentity = createHash("sha256").update(contents).digest("hex");
  // Issue executions cannot write the device's private state. Their catalogs
  // belong to the same writable scratch root as their session artifacts.
  const scratch = env.FOUNDRY_EXECUTION_SESSION_ROOT?.trim();
  const path = scratch
    ? resolve(scratch, "codex-models", `${contentIdentity}.json`)
    : foundryStatePath(
        "native-runtime",
        "codex-models",
        `${contentIdentity}.json`,
      );
  let current: string | undefined;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    /* First use of this exact native catalog and resolved window. */
  }
  if (current !== contents) writeFileAtomic(path, contents);
  return ["-c", `model_catalog_json=${JSON.stringify(path)}`];
}
