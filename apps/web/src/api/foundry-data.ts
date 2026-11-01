import type { WorkspaceProjection } from "@bd777/foundry-protocol";
import type { FoundryData, FoundryDataField } from "../api-types";
import { ApiError, sharedGet, type RequestOptions } from "./http";

export const emptyWorkspace: WorkspaceProjection = {
  id: "",
  name: "No workspace",
  localPath: "Run local daemon setup",
  baseline: "main",
  contextSummary: "No local daemon has registered a workspace yet.",
  acceptedCount: 0,
  resolvedCount: 0,
};

/**
 * The workspace id a data read sends when the person has no workspace
 * selected: the answer shows no workspace instead of picking one.
 */
export const noWorkspaceSelected = "none";

/**
 * Reads workspace data: without `fields`, every field but the pages' own
 * (the skill library's catalog); with them, those fields and the workspace.
 * Each selection keeps its own ETag, so an unchanged read costs a 304.
 */
export async function loadFoundryData(
  activeWorkspaceId?: string,
  options: RequestOptions & { fields?: readonly FoundryDataField[] } = {},
): Promise<FoundryDataLoadResult> {
  const params = new URLSearchParams();
  if (activeWorkspaceId) params.set("workspaceId", activeWorkspaceId);
  const fields = options.fields ? [...new Set(options.fields)].sort() : [];
  if (fields.length) params.set("fields", fields.join(","));
  const query = params.toString() ? `?${params.toString()}` : "";
  const selection = fields.length ? fields : undefined;
  try {
    return await getFoundryData(
      `/api/foundry-data${query}`,
      options,
      selection,
    );
  } catch (error) {
    // The workspace is gone: read the rest, whole, with no workspace
    // selected. Another is never picked in its place; Switch picks one.
    if (
      activeWorkspaceId &&
      activeWorkspaceId !== noWorkspaceSelected &&
      error instanceof ApiError &&
      error.status === 404
    ) {
      return getFoundryData(
        `/api/foundry-data?workspaceId=${noWorkspaceSelected}`,
        options,
      );
    }
    throw error;
  }
}

export interface FoundryDataLoadResult {
  /** A selection's answer holds only its fields (and the workspace). */
  data: FoundryData;
  notModified: boolean;
  /** The fields read; undefined: every field but the pages' own. */
  fields?: readonly FoundryDataField[];
  /** When the read was asked for (Date.now()): its answer is older. */
  requestedAt: number;
}

/**
 * The fields that differ between workspaces: what a switch reads. The
 * others (the workspace list, devices, connections, and what derives from
 * devices alone) are the same whichever workspace is shown; the stream
 * keeps them current, and a switch keeps them as shown.
 */
export const workspaceSwitchFields: readonly FoundryDataField[] = [
  "agentProfiles",
  "agents",
  "agentSessions",
  "assets",
  "chats",
  "defaultBundleIds",
  "defaultSkillIds",
  "inheritedSkillIds",
  "issues",
  "offSkillIds",
  "providerHealth",
  "runs",
  "skillBundles",
  "workspaceBundleIds",
  "workspaceFiles",
  "workspaceSkillBindings",
  "workspaceSkills",
];

// Warm only the row the user points at or focuses. Consume each result once so
// a later visit cannot keep reusing a stale workspace snapshot.
const workspacePreloads = new Map<
  string,
  {
    startedAt: number;
    result: Promise<FoundryDataLoadResult | undefined>;
  }
>();
const workspacePreloadTTL = 5_000;

/** Drops warmed workspace reads after a change to workspaces or devices. */
export function forgetWorkspacePreloads(): void {
  workspacePreloads.clear();
}

export function prefetchFoundryWorkspace(workspaceId: string): void {
  if (!workspaceId) return;
  const existing = workspacePreloads.get(workspaceId);
  if (existing && Date.now() - existing.startedAt < workspacePreloadTTL) return;
  if (workspacePreloads.size >= 4) {
    workspacePreloads.delete(workspacePreloads.keys().next().value!);
  }
  workspacePreloads.set(workspaceId, {
    startedAt: Date.now(),
    result: loadFoundryData(workspaceId, {
      fields: workspaceSwitchFields,
    }).catch(() => undefined),
  });
}

/**
 * Reads a workspace to switch to it: what differs between workspaces
 * (workspaceSwitchFields), or everything when `whole` (nothing is shown
 * yet to keep the rest of).
 */
export async function loadFoundryWorkspace(
  workspaceId: string,
  options: RequestOptions & { whole?: boolean } = {},
): Promise<FoundryDataLoadResult> {
  const preloaded = workspacePreloads.get(workspaceId);
  workspacePreloads.delete(workspaceId);
  if (
    !options.whole &&
    preloaded &&
    Date.now() - preloaded.startedAt < workspacePreloadTTL
  ) {
    const result = await preloaded.result;
    options.signal?.throwIfAborted();
    if (result) return result;
  }
  return loadFoundryData(workspaceId, {
    signal: options.signal,
    fields: options.whole ? undefined : workspaceSwitchFields,
  });
}

/** Each read's answer as this tab parsed it, by path, with its ETag. */
const foundryDataCache = new Map<string, { data: FoundryData; etag: string }>();

async function getFoundryData(
  path: string,
  options: RequestOptions,
  fields?: readonly FoundryDataField[],
): Promise<FoundryDataLoadResult> {
  const answer = await sharedGet(path, options);
  const { requestedAt } = answer;
  // The same answer as this tab's last (it would have been a 304).
  const cached = foundryDataCache.get(path);
  if (cached && answer.etag && cached.etag === answer.etag) {
    return { data: cached.data, notModified: true, fields, requestedAt };
  }
  const data = JSON.parse(answer.body) as FoundryData;
  // Every field but the workspace is a list: one answered null (an empty
  // list) is one.
  for (const [field, value] of Object.entries(data))
    if (value === null)
      (data as unknown as Record<string, unknown>)[field] = [];
  if (answer.etag) {
    foundryDataCache.set(path, { data, etag: answer.etag });
  }
  return { data, notModified: false, fields, requestedAt };
}
