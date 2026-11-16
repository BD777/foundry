import type {
  ContextPatchReply,
  PersonalAgentContextPatch,
  PersonalAgentMaintenance,
  WorkspaceUpkeep,
} from "@bd777/foundry-protocol";
import { request } from "./http";

const base = (workspaceId: string) =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/upkeep`;

export const listWorkspaceUpkeep = (
  workspaceId: string,
): Promise<WorkspaceUpkeep> => request("GET", base(workspaceId));

export function actOnWorkspaceUpkeep(
  workspaceId: string,
  id: string,
  revision: number,
  action: "retry" | "dismiss",
): Promise<PersonalAgentMaintenance> {
  return request("POST", `${base(workspaceId)}/${encodeURIComponent(id)}`, {
    body: { revision, action },
  });
}

export function previewWorkspaceUpkeepPatch(
  workspaceId: string,
  id: string,
  revision: number,
  index: number,
): Promise<ContextPatchReply> {
  return request(
    "POST",
    `${base(workspaceId)}/${encodeURIComponent(id)}/patch`,
    { body: { revision, index, action: "preview" } },
  );
}

export function applyWorkspaceUpkeepPatch(
  workspaceId: string,
  id: string,
  revision: number,
  index: number,
  reviewedHash: string,
): Promise<PersonalAgentContextPatch> {
  return request(
    "POST",
    `${base(workspaceId)}/${encodeURIComponent(id)}/patch`,
    { body: { revision, index, action: "apply", reviewedHash } },
  );
}
