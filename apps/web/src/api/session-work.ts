import type {
  SessionWorkList,
  WorkControlInput,
  WorkOperation,
} from "@bd777/foundry-protocol";
import { request } from "./http";
export function listSessionWork(sessionId: string): Promise<SessionWorkList> {
  return request(
    "GET",
    `/api/agent-sessions/${encodeURIComponent(sessionId)}/work`,
  );
}
export function controlSessionWork(
  sessionId: string,
  input: WorkControlInput,
): Promise<WorkOperation> {
  return request(
    "POST",
    `/api/agent-sessions/${encodeURIComponent(sessionId)}/work/operations`,
    { body: input },
  );
}

export function listWorkspaceServices(
  workspaceId: string,
): Promise<import("@bd777/foundry-protocol").SessionWork[]> {
  return request(
    "GET",
    `/api/workspaces/${encodeURIComponent(workspaceId)}/services`,
  );
}
export function controlWorkspaceService(
  workspaceId: string,
  id: string,
  input: WorkControlInput,
): Promise<WorkOperation> {
  return request(
    "POST",
    `/api/workspaces/${encodeURIComponent(workspaceId)}/services/${encodeURIComponent(id)}/operations`,
    { body: input },
  );
}
