import type {
  PersonalAgentMaintenance,
  PersonalAgentContextPatch,
  ContextPatchReply,
} from "@bd777/foundry-protocol";
import { request } from "./http";
const base = "/api/personal-agent";
export const listPersonalAgentMaintenance = (): Promise<
  PersonalAgentMaintenance[]
> => request("GET", `${base}/maintenance`);
export const listPersonalAgentContextPatches = (): Promise<
  PersonalAgentContextPatch[]
> => request("GET", `${base}/context-patches`);
export function actOnPersonalAgentMaintenance(
  id: string,
  revision: number,
  action: "retry" | "dismiss",
): Promise<PersonalAgentMaintenance> {
  return request("POST", `${base}/maintenance/${encodeURIComponent(id)}`, {
    body: { revision, action },
  });
}
export function previewPersonalAgentPatch(
  id: string,
  revision: number,
  index: number,
): Promise<ContextPatchReply> {
  return request(
    "POST",
    `${base}/maintenance/${encodeURIComponent(id)}/patch`,
    { body: { revision, index, action: "preview" } },
  );
}
export function applyPersonalAgentPatch(
  id: string,
  revision: number,
  index: number,
  reviewedHash: string,
): Promise<PersonalAgentContextPatch> {
  return request(
    "POST",
    `${base}/maintenance/${encodeURIComponent(id)}/patch`,
    { body: { revision, index, action: "apply", reviewedHash } },
  );
}
