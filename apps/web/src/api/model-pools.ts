import type { ModelPool, ModelPoolInput } from "@bd777/foundry-protocol";
import { request } from "./http";

export function listModelPools(): Promise<ModelPool[]> {
  return request("GET", "/api/model-pools");
}

export function createModelPool(input: ModelPoolInput): Promise<ModelPool> {
  return request("POST", "/api/model-pools", { body: input });
}

export function updateModelPool(
  id: string,
  input: ModelPoolInput,
): Promise<ModelPool> {
  return request("PUT", `/api/model-pools/${encodeURIComponent(id)}`, {
    body: input,
  });
}

export function deleteModelPool(id: string): Promise<{ deleted: string }> {
  return request("DELETE", `/api/model-pools/${encodeURIComponent(id)}`);
}
