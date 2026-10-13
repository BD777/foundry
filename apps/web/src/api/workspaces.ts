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
import { forgetWorkspacePreloads } from "./foundry-data";
import { request, type RequestOptions } from "./http";

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
