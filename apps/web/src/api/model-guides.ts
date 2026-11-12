import type {
  ModelGuideDetail,
  ModelGuideList,
  ModelGuideResolution,
  ModelGuideRevision,
  ModelObservationPage,
} from "@bd777/foundry-protocol";
import { request } from "./http";

export interface ModelGuideTarget {
  providerKind: string;
  providerId: string;
  runtime: string;
  model: string;
}

const guidePath = (id: string) => `/api/model-guides/${encodeURIComponent(id)}`;

export function listModelGuides(): Promise<ModelGuideList> {
  return request("GET", "/api/model-guides");
}

export function getModelGuide(id: string): Promise<ModelGuideDetail> {
  return request("GET", guidePath(id));
}

export function getModelGuideRevision(
  id: string,
  revision: number,
): Promise<ModelGuideRevision> {
  return request("GET", `${guidePath(id)}/revisions/${revision}`);
}

export function listModelGuideObservations(
  id: string,
  { offset = 0, limit = 20 }: { offset?: number; limit?: number } = {},
): Promise<ModelObservationPage> {
  return request(
    "GET",
    `${guidePath(id)}/observations?offset=${offset}&limit=${limit}`,
  );
}

export function resolveModelGuide(
  target: ModelGuideTarget,
): Promise<ModelGuideResolution> {
  return request(
    "GET",
    `/api/model-guides/resolve?${new URLSearchParams({ ...target })}`,
  );
}

/** Resolves many provider models at once; the answers keep the order asked. */
export function resolveModelGuides(
  targets: ModelGuideTarget[],
): Promise<{ resolutions: ModelGuideResolution[] }> {
  return request("POST", "/api/model-guides/resolve", { body: { targets } });
}
