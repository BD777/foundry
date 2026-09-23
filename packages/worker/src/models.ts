/**
 * Agent model listing. Native CLIs answer for their own logins; a compatible
 * endpoint is asked for its catalog over its own `/models` route, which is the
 * only way an endpoint can tell us what it serves.
 */

import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import type { AgentModelOption } from "@foundry/protocol";
import {
  profileConfigFromInput,
  type AgentProfileLocalConfig,
  type UpsertAgentProfilePayload,
} from "./profiles.js";
import { codexCommandCandidates } from "./utils.js";
import {
  readClaudeCatalog,
  readOfficialCodexCatalog,
} from "./native-inspection.js";

const execFileAsync = promisify(execFile);
const localModelCache = new Map<
  string,
  { expiresAt: number; promise: Promise<AgentModelOption[]> }
>();

function isExecutableFile(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export async function listAgentModelsConfig(
  input: UpsertAgentProfilePayload["profile"],
  _workspacePath: string,
  nativeCatalog = {
    claude: readClaudeCatalog,
    codex: readOfficialCodexCatalog,
  },
): Promise<AgentModelOption[]> {
  const profile = profileConfigFromInput(input);
  const baseUrl = profile.baseUrl?.trim();
  const isLogin = profile.connectionType === "local_login";
  if (profile.runtime === "codex" && isLogin) return nativeCatalog.codex();
  if (profile.runtime === "codex" && !baseUrl) {
    return listCodexLocalModels();
  }
  if (isLogin && profile.runtime === "claude") return nativeCatalog.claude();
  if (!baseUrl) {
    // A Claude login has no catalog command, and a login has no endpoint to
    // ask even when a stale base URL is lying around.
    return profile.model?.trim() ? [{ id: profile.model.trim() }] : [];
  }
  return await listEndpointModels(profile, baseUrl);
}

/**
 * Catalog listing for a compatible endpoint. This is a metadata read — never a
 * completion — so inference still runs only through the native agent SDK or
 * CLI. The key comes from the same place a run would take it, and neither the
 * key nor the response is logged.
 */
async function listEndpointModels(
  profile: AgentProfileLocalConfig,
  baseUrl: string,
): Promise<AgentModelOption[]> {
  const anthropic = profile.connectionType === "anthropic_compatible";
  const key =
    profile.apiKey?.trim() ||
    (anthropic
      ? process.env.ANTHROPIC_AUTH_TOKEN?.trim() ||
        process.env.ANTHROPIC_API_KEY?.trim()
      : process.env.OPENAI_API_KEY?.trim()) ||
    "";
  const headers: Record<string, string> = { accept: "application/json" };
  if (key && anthropic) {
    headers["x-api-key"] = key;
    headers.authorization = `Bearer ${key}`;
    headers["anthropic-version"] = "2023-06-01";
  } else if (key) {
    headers.authorization = `Bearer ${key}`;
  }

  let lastRefusal = "";
  for (const url of catalogURLs(baseUrl)) {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      lastRefusal = `answered ${response.status}`;
      continue;
    }
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      // A login page or proxy error page is not a catalog.
      lastRefusal = "answered with a page instead of a model list";
      continue;
    }
    const models = modelsFromResponse(body);
    if (models.length === 0) {
      lastRefusal = "listed no models";
      continue;
    }
    return models;
  }
  throw new Error(
    `${new URL(baseUrl).host} ${lastRefusal || "has no model list"}. Type the model instead.`,
  );
}

/**
 * A compatible endpoint keeps its catalog next to its completions route, but a
 * base URL may or may not already carry the version segment, so both shapes are
 * asked before giving up.
 */
function catalogURLs(baseUrl: string): string[] {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.endsWith("/models")) return [trimmed];
  const direct = `${trimmed}/models`;
  return /\/v\d+$/.test(trimmed) ? [direct] : [direct, `${trimmed}/v1/models`];
}

/** OpenAI and Anthropic both wrap their catalog in `data`. */
function modelsFromResponse(body: unknown): AgentModelOption[] {
  const rows = catalogRows(body);
  const options: AgentModelOption[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const id = "id" in row && typeof row.id === "string" ? row.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label = catalogLabel(row);
    options.push(label ? { id, label } : { id });
  }
  return options;
}

function catalogRows(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object" && "data" in body) {
    const data = body.data;
    if (Array.isArray(data)) return data;
  }
  return [];
}

function catalogLabel(row: object): string | undefined {
  if ("display_name" in row && typeof row.display_name === "string") {
    return row.display_name;
  }
  if ("name" in row && typeof row.name === "string") {
    return row.name;
  }
  return undefined;
}

export function listCodexLocalModels(): Promise<AgentModelOption[]> {
  const candidates = codexCommandCandidates();
  const key = JSON.stringify([
    candidates,
    process.env.CODEX_HOME,
    process.env.PATH,
  ]);
  const cached = localModelCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  const entry = {
    expiresAt: Infinity,
    promise: discoverCodexModels(candidates),
  };
  localModelCache.set(key, entry);
  // A single in-flight process serves concurrent requests. Failed discovery is
  // never cached; successful lists are reusable for five minutes.
  void entry.promise.then(
    () => {
      entry.expiresAt = Date.now() + 300000;
    },
    () => {
      if (localModelCache.get(key) === entry) localModelCache.delete(key);
    },
  );
  if (localModelCache.size > 8)
    localModelCache.delete(localModelCache.keys().next().value!);
  return entry.promise;
}

async function discoverCodexModels(
  candidates: string[],
): Promise<AgentModelOption[]> {
  // An absolute path is judged by the filesystem rather than by spawning
  // `--version` first: a second process buys nothing, and a slow-starting CLI
  // under launchd used to read as "not installed".
  const command =
    candidates.find(
      (candidate) => isAbsolute(candidate) && isExecutableFile(candidate),
    ) ?? candidates.find((candidate) => !isAbsolute(candidate));
  if (!command)
    throw new Error(
      `Codex CLI is not available (looked in ${candidates.join(", ")})`,
    );
  let result: { stdout: string };
  try {
    result = await execFileAsync(command, ["debug", "models"], {
      encoding: "utf8",
      // The first spawn of a large signed binary under launchd waits on the
      // system's code-signing check; 15s used to time that out.
      timeout: 75000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    // Say how the CLI refused. An empty "Command failed" leaves the operator
    // guessing between a crash, a signal, and a timeout.
    const detail = error as {
      code?: number | string;
      signal?: string;
      stderr?: string;
    };
    const because =
      detail.stderr?.trim() ||
      (detail.signal
        ? `killed by ${detail.signal}`
        : `exit ${detail.code ?? "unknown"}`);
    throw new Error(`${command} debug models failed: ${because}`);
  }
  const body = JSON.parse(result.stdout) as { models?: unknown[] };
  const seen = new Set<string>();
  const options: AgentModelOption[] = [];
  for (const item of body.models ?? []) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const model = item as {
      display_name?: unknown;
      slug?: unknown;
      visibility?: unknown;
    };
    if (model.visibility && model.visibility !== "list") {
      continue;
    }
    const id = typeof model.slug === "string" ? model.slug : "";
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const label =
      typeof model.display_name === "string" ? model.display_name : id;
    options.push({ id, label: label === id ? undefined : label });
  }
  return options;
}
