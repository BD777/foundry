import type {
  PersonalAgentMaintenance,
  PersonalAgentContextPatch,
  ContextPatchReply,
} from "@bd777/foundry-protocol";
import { request } from "./http";
import { personalAgentApiBase } from "./personal-agent";

export const listPersonalAgentMaintenance = (
  assistantId?: string,
): Promise<PersonalAgentMaintenance[]> =>
  request("GET", `${personalAgentApiBase(assistantId)}/maintenance`);
export const listPersonalAgentContextPatches = (
  assistantId?: string,
): Promise<PersonalAgentContextPatch[]> =>
  request("GET", `${personalAgentApiBase(assistantId)}/context-patches`);
export function actOnPersonalAgentMaintenance(
  assistantId: string | undefined,
  id: string,
  revision: number,
  action: "retry" | "dismiss",
): Promise<PersonalAgentMaintenance> {
  return request(
    "POST",
    `${personalAgentApiBase(assistantId)}/maintenance/${encodeURIComponent(id)}`,
    { body: { revision, action } },
  );
}
export function previewPersonalAgentPatch(
  assistantId: string | undefined,
  id: string,
  revision: number,
  index: number,
): Promise<ContextPatchReply> {
  return request(
    "POST",
    `${personalAgentApiBase(assistantId)}/maintenance/${encodeURIComponent(id)}/patch`,
    { body: { revision, index, action: "preview" } },
  );
}
export function applyPersonalAgentPatch(
  assistantId: string | undefined,
  id: string,
  revision: number,
  index: number,
  reviewedHash: string,
): Promise<PersonalAgentContextPatch> {
  return request(
    "POST",
    `${personalAgentApiBase(assistantId)}/maintenance/${encodeURIComponent(id)}/patch`,
    { body: { revision, index, action: "apply", reviewedHash } },
  );
}
