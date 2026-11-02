import type {
  WorkspaceDirectoryEntry,
  WorkspaceFileRead,
  WorkspaceProjection,
  WorkspaceRelinkResult,
  WorkspaceRelinkSuggestion,
  WorkspaceTreeEntry,
} from "@bd777/foundry-protocol";
import type {
  CreateWorkspaceInput,
  ListWorkspaceSubdirectoriesInput,
  ReadWorkspaceFileInput,
  WorkspaceInspection,
} from "../api-types";
import { apiBaseUrl } from "../lib/api-base-url";
import { deviceFileIntentHeaders } from "./devices";
import { forgetWorkspacePreloads } from "./foundry-data";
import { apiErrorOf, apiFetch, request, type RequestOptions } from "./http";

const workspacePath = (workspaceId: string) =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}`;

export function inspectWorkspace(
  workspaceId: string,
  rescan = false,
): Promise<WorkspaceInspection> {
  const path = `${workspacePath(workspaceId)}/inspection`;
  return rescan ? request("POST", `${path}/rescan`) : request("GET", path);
}

export function createWorkspace(
  input: CreateWorkspaceInput,
): Promise<WorkspaceProjection> {
  return request("POST", "/api/workspaces", { body: input });
}

export async function deleteWorkspace(
  workspaceId: string,
): Promise<WorkspaceProjection> {
  const workspace = await request<WorkspaceProjection>(
    "DELETE",
    workspacePath(workspaceId),
  );
  forgetWorkspacePreloads();
  return workspace;
}

export async function renameWorkspace(
  workspaceId: string,
  name: string,
): Promise<WorkspaceProjection> {
  const workspace = await request<WorkspaceProjection>(
    "PATCH",
    workspacePath(workspaceId),
    { body: { name } },
  );
  forgetWorkspacePreloads();
  return workspace;
}

/**
 * Points a workspace at its folder's new path on its device: the same
 * workspace, with its chats, sessions, Issues and settings.
 */
export async function relinkWorkspace(
  workspaceId: string,
  path: string,
): Promise<WorkspaceRelinkResult> {
  const result = await request<WorkspaceRelinkResult>(
    "POST",
    `${workspacePath(workspaceId)}/relink`,
    { body: { path } },
  );
  forgetWorkspacePreloads();
  return result;
}

/** Folders on the workspace's device that look like its moved folder. */
export async function listWorkspaceRelinkSuggestions(
  workspaceId: string,
  options: RequestOptions = {},
): Promise<WorkspaceRelinkSuggestion[]> {
  const answer = await request<{
    suggestions?: WorkspaceRelinkSuggestion[] | null;
  }>("GET", `${workspacePath(workspaceId)}/relink-suggestions`, options);
  return answer.suggestions ?? [];
}

export function listWorkspaceSubdirectories(
  input: ListWorkspaceSubdirectoriesInput,
): Promise<WorkspaceDirectoryEntry[]> {
  return request("POST", "/api/workspaces/subdirectories", { body: input });
}

export function readWorkspaceFile(
  input: ReadWorkspaceFileInput,
  options: RequestOptions = {},
): Promise<WorkspaceFileRead> {
  const params = new URLSearchParams({
    path: input.path,
    workspaceId: input.workspaceId,
  });
  return request(
    "GET",
    `/api/workspace-files/read?${params.toString()}`,
    options,
  );
}

export function listWorkspaceTree(
  input: { workspaceId: string; path?: string },
  options: RequestOptions = {},
): Promise<WorkspaceTreeEntry[]> {
  const params = new URLSearchParams({
    path: input.path ?? "",
    workspaceId: input.workspaceId,
  });
  return request(
    "GET",
    `/api/workspace-files/tree?${params.toString()}`,
    options,
  );
}

export function localImageUrl(path: string): string {
  const params = new URLSearchParams({ path });
  return `${apiBaseUrl}/api/local-files/image?${params.toString()}`;
}

/**
 * Reads an image by its URL (`localImageUrl`, a session frame's): `variant`
 * asks for a smaller derivative, `fresh` reads past the browser's and the
 * server's caches.
 */
export function fetchImage(
  source: string,
  {
    variant,
    fresh = false,
    signal,
  }: {
    variant?: "preview" | "placeholder";
    fresh?: boolean;
    signal: AbortSignal;
  },
): Promise<Response> {
  return apiFetch(
    `${source}${variant ? `&variant=${variant}` : ""}${fresh ? "&refresh=1" : ""}`,
    { signal, cache: fresh ? "reload" : "default" },
  );
}

/**
 * Starts downloading a file of a workspace, a session, or a device outside
 * its workspaces: the response, whose body the caller reads with its
 * progress; the server's refusal as its error.
 */
export async function fetchFileDownload(
  target: {
    deviceId?: string;
    path: string;
    workspaceId?: string;
    sessionId?: string;
  },
  signal: AbortSignal,
): Promise<Response> {
  const { deviceId, path, workspaceId, sessionId } = target;
  const params = new URLSearchParams({ path });
  if (!sessionId && !deviceId) params.set("workspaceId", workspaceId ?? "");
  const endpoint = deviceId
    ? `/api/devices/${encodeURIComponent(deviceId)}/files/download`
    : sessionId
      ? `/api/agent-sessions/${encodeURIComponent(sessionId)}/files/download`
      : "/api/workspace-files/download";
  const response = await apiFetch(`${apiBaseUrl}${endpoint}?${params}`, {
    signal,
    cache: "no-store",
    ...(deviceId ? { headers: deviceFileIntentHeaders } : {}),
  });
  if (!response.ok)
    throw apiErrorOf(await response.text(), endpoint, response.status);
  return response;
}
