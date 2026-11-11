import type {
  EdgeAccess,
  EdgeAccessInput,
  EdgeAccessList,
  EdgeAccessRequired,
} from "@bd777/foundry-protocol";
import { request } from "./http";

const edgeAccessPath = (id?: string) =>
  `/api/edge-access${id ? `/${encodeURIComponent(id)}` : ""}`;

/** Credentials are metadata only; their client ID and secret stay sealed. */
export function getEdgeAccessCredentials(): Promise<EdgeAccessList> {
  return request<EdgeAccessList>("GET", edgeAccessPath());
}

export function createEdgeAccessCredential(
  input: EdgeAccessInput,
): Promise<EdgeAccess> {
  return request<EdgeAccess>("POST", edgeAccessPath(), { body: input });
}

export function replaceEdgeAccessCredential(
  id: string,
  input: EdgeAccessInput,
): Promise<EdgeAccess> {
  return request<EdgeAccess>("PUT", edgeAccessPath(id), { body: input });
}

export function deleteEdgeAccessCredential(id: string): Promise<void> {
  return request<void>("DELETE", edgeAccessPath(id));
}

export interface EdgeAccessIngressSuggestion {
  hostname: string;
  path?: string;
  service: string;
  note: string;
}

export interface EdgeAccessProvisionResult {
  edgeAccess: EdgeAccess;
  accountId: string;
  serviceTokenName: string;
  serviceTokenId: string;
  applicationId?: string;
  policyId?: string;
  needsIngress: boolean;
  suggestedIngress?: EdgeAccessIngressSuggestion;
}

/** Creates a Cloudflare Access application, policy, and service token. */
export function provisionEdgeAccess(
  required: EdgeAccessRequired,
): Promise<EdgeAccessProvisionResult> {
  return request<EdgeAccessProvisionResult>(
    "POST",
    `${edgeAccessPath()}/provision`,
    {
      body: {
        provider: required.provider,
        team: required.team ?? "",
        host: required.host,
        path: required.path,
      },
    },
  );
}
