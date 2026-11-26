import { NativeAccountChangedError } from "./native-account-changed.js";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentModelOption,
  NativeAccountInspection,
  ProviderHealth,
} from "@bd777/foundry-protocol";
import { acquireRuntime } from "../agent-runtime/maintenance.js";
import { AcpClient } from "../agent-runtime/acp-client.js";
import {
  antigravityBoundProfile,
  antigravityLoginBinding,
  antigravityHome,
  antigravityInvocation,
  requireAntigravityLogin,
} from "./antigravity.js";
import { nativeCli } from "./native-cli.js";

type Model = { modelId: string; name?: string };
type Choice = { value?: string; name?: string; options?: Choice[] };
type Session = {
  sessionId: string;
  configOptions?: Array<{
    category?: string;
    id: string;
    currentValue?: string;
    options?: Choice[];
  }>;
  models?: { currentModelId?: string; availableModels?: Model[] };
};
export async function readAntigravityCatalog(
  profileId: string,
): Promise<AgentModelOption[]> {
  const directory = mkdtempSync(join(tmpdir(), "foundry-agy-catalog-"));
  let release: (() => void) | undefined;
  let client: AcpClient | undefined;
  try {
    release = await acquireRuntime("antigravity", AbortSignal.timeout(30_000));
    requireAntigravityLogin(profileId);
    client = new AcpClient(antigravityInvocation(profileId), directory);
    const timer = setTimeout(() => client?.close(), 30000);
    try {
      await client.initialize();
      const session = (await client.request("session/new", {
        cwd: directory,
        mcpServers: [],
      })) as Session;
      const modelChoice = session.configOptions?.find(
        (o) => o.category === "model" || o.id === "model",
      );
      const options = modelChoice?.options ?? [];
      const models = options
        .flatMap((o) => o.options ?? [o])
        .flatMap((o) =>
          typeof o.value === "string" ? [{ id: o.value, label: o.name }] : [],
        );
      const effortChoice = session.configOptions?.find(
        (o) => o.category === "thought_level" || o.id === "thought_level",
      );
      const efforts = effortChoice?.options
        ?.flatMap((o) => o.options ?? [o])
        .flatMap((o) => (o.value ? [o.value] : []));
      const current =
        modelChoice?.currentValue ?? session.models?.currentModelId;
      const catalog = models.length
        ? models
        : (session.models?.availableModels ?? []).map((m) => ({
            id: m.modelId,
            label: m.name,
          }));
      return catalog.map((row) =>
        row.id === current && efforts?.length
          ? { ...row, reasoningEfforts: efforts }
          : row,
      );
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await client?.close();
    release?.();
    rmSync(directory, { recursive: true, force: true });
  }
}

const statusCache = new Map<
  string,
  { until: number; health: ProviderHealth }
>();
const probing = new Set<string>();
let generation = 0;
let revision = 0;
export function antigravityHealthRevision(): number {
  return revision;
}

export function antigravityGeneration(profileId: string): string | undefined {
  const binary = nativeCli("antigravity").generation;
  if (!binary) return undefined;
  const binding = antigravityLoginBinding();
  return `${binary}:${profileId}:${binding?.profileId === profileId ? binding.generation : "signed-out"}`;
}
export function clearAntigravityHealth(): void {
  generation++;
  revision++;
  statusCache.clear();
}

function offlineHealth(profileId: string): ProviderHealth | undefined {
  const cli = nativeCli("antigravity");
  const base = {
    provider: "antigravity",
    cli,
    secretStored: "local",
    authMode: "missing",
  } as const;
  if (!cli.installed)
    return {
      ...base,
      status: "unavailable",
      statusDetail: "Install the Antigravity CLI on this device.",
    };
  if (antigravityBoundProfile() !== profileId)
    return {
      ...base,
      status: "missing_auth",
      statusDetail: "Sign in to this Antigravity profile.",
    };
  return undefined;
}

const base = {
  provider: "antigravity",
  secretStored: "local",
  authMode: "missing",
} as const;
async function checkAntigravityHealth(
  profileId: string,
): Promise<ProviderHealth> {
  const offline = offlineHealth(profileId);
  if (offline) return offline;
  const release = await acquireRuntime(
    "antigravity",
    AbortSignal.timeout(20_000),
  );
  try {
    requireAntigravityLogin(profileId);
    const { command, env } = antigravityInvocation(profileId);
    // models has no directory flags; HOME gives it the identical .gemini /
    // antigravity-cli layout used by the ACP login and runner.
    return await new Promise<ProviderHealth>((resolve) =>
      execFile(
        command,
        ["models"],
        {
          env,
          cwd: antigravityHome(profileId),
          timeout: 15000,
          maxBuffer: 512 * 1024,
        },
        (err, stdout, stderr) => {
          if (!err)
            resolve({
              ...base,
              status: "healthy",
              authMode: "local_config",
              statusDetail: "The Antigravity CLI could read the model catalog.",
            });
          else if (
            /please sign in|authentication required/i.test(stdout + stderr)
          )
            resolve({
              ...base,
              status: "missing_auth",
              statusDetail:
                "Antigravity requires a Google login on this device.",
            });
          else
            resolve({
              ...base,
              status: "unavailable",
              statusDetail:
                "Antigravity could not read the model catalog. Check the CLI, network and OS keyring.",
            });
        },
      ),
    );
  } finally {
    release();
  }
}

export function antigravityHealth(
  profileId = "antigravity_local",
): ProviderHealth {
  const offline = offlineHealth(profileId);
  if (offline) return offline;
  const cached = statusCache.get(profileId);
  if ((!cached || cached.until < Date.now()) && !probing.has(profileId)) {
    const started = generation;
    probing.add(profileId);
    void checkAntigravityHealth(profileId)
      .then((health) => {
        if (generation === started) {
          if (cached?.health.status !== health.status) revision++;
          statusCache.set(profileId, { until: Date.now() + 60000, health });
        }
      })
      .catch(() => {})
      .finally(() => probing.delete(profileId));
  }
  return (
    cached?.health ?? {
      cli: nativeCli("antigravity"),
      ...base,
      status: "unavailable",
      statusDetail: "Checking the Antigravity login.",
    }
  );
}

export async function inspectAntigravity(
  profileId = "antigravity_local",
  expectedGeneration?: string,
): Promise<NativeAccountInspection> {
  const runtimeGeneration = antigravityGeneration(profileId);
  if (expectedGeneration && expectedGeneration !== runtimeGeneration)
    throw new NativeAccountChangedError(
      "The Antigravity login changed. Reload this profile.",
    );
  const health = await checkAntigravityHealth(profileId);
  if (antigravityGeneration(profileId) !== runtimeGeneration)
    throw new NativeAccountChangedError(
      "The Antigravity login changed during account inspection.",
    );
  statusCache.set(profileId, { until: Date.now() + 60000, health });
  const home = antigravityHome(profileId);
  return {
    runtime: "antigravity",
    runtimeGeneration,
    source: home,
    sources: [home],
    executionSource: home,
    checkedAt: new Date().toISOString(),
    status:
      health.status === "healthy"
        ? "verified"
        : health.status === "missing_auth"
          ? "not_signed_in"
          : "unavailable",
    authMode: health.status === "healthy" ? "subscription" : "unknown",
    message: health.statusDetail ?? "",
    usage: [],
    quotaStatus: "unsupported",
    quotaReason: "not_exposed",
  };
}
