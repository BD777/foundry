import type {
  ExecutionDefaultsView,
  ModelNote,
  ModelNoteInput,
  ModelNotePage,
} from "@bd777/foundry-protocol";
import { request } from "./http";

export type ModelNoteTarget = Omit<ModelNoteInput, "body">;
export interface ExecutionDefaultInput {
  providerId: string;
  runtime: string;
  model: string;
  effort: string;
}

function modelNoteQuery(
  target: ModelNoteTarget,
  offset?: number,
  limit?: number,
) {
  const query = new URLSearchParams({
    providerKind: target.providerKind,
    providerId: target.providerId,
    runtime: target.runtime,
    model: target.model,
  });
  if (offset !== undefined) query.set("offset", String(offset));
  if (limit !== undefined) query.set("limit", String(limit));
  return query;
}

export function listModelNotes(
  target: ModelNoteTarget,
  { offset = 0, limit = 20 }: { offset?: number; limit?: number } = {},
): Promise<ModelNotePage> {
  return request(
    "GET",
    `/api/model-notes?${modelNoteQuery(target, offset, limit)}`,
  );
}

export function appendModelNote(input: ModelNoteInput): Promise<ModelNote> {
  return request("POST", "/api/model-notes", { body: input });
}

export function updateModelNote(id: string, body: string): Promise<ModelNote> {
  return request("PUT", `/api/model-notes/${encodeURIComponent(id)}`, {
    body: { body },
  });
}

export function deleteModelNote(id: string): Promise<{ deleted: string }> {
  return request("DELETE", `/api/model-notes/${encodeURIComponent(id)}`);
}

const globalPath = "/api/execution-default";
const workspacePath = (workspaceId: string) =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/execution-default`;

export function getExecutionDefault(
  workspaceId?: string,
): Promise<ExecutionDefaultsView> {
  return request("GET", workspaceId ? workspacePath(workspaceId) : globalPath);
}

export function setExecutionDefault(
  input: Partial<ExecutionDefaultInput>,
  workspaceId?: string,
): Promise<ExecutionDefaultsView> {
  return request("PUT", workspaceId ? workspacePath(workspaceId) : globalPath, {
    body: input,
  });
}
