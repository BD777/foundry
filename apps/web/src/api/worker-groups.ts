import type { WorkerGroup, WorkerGroupInput } from "@bd777/foundry-protocol";
import { request } from "./http";

export function listWorkerGroups(): Promise<WorkerGroup[]> {
  return request("GET", "/api/worker-groups");
}

export function createWorkerGroup(
  input: WorkerGroupInput,
): Promise<WorkerGroup> {
  return request("POST", "/api/worker-groups", { body: input });
}

export function updateWorkerGroup(
  id: string,
  input: WorkerGroupInput,
): Promise<WorkerGroup> {
  return request("PUT", `/api/worker-groups/${encodeURIComponent(id)}`, {
    body: input,
  });
}

export function deleteWorkerGroup(id: string): Promise<{ deleted: string }> {
  return request("DELETE", `/api/worker-groups/${encodeURIComponent(id)}`);
}
