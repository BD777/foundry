import type { PersonalAgentMaintenance } from "@bd777/foundry-protocol";
import { request } from "./http";
import { personalAgentApiBase } from "./personal-agent";

/** This assistant's own memory-layer upkeep (DEV-256). */
export const listPersonalAgentMaintenance = (
  assistantId?: string,
): Promise<PersonalAgentMaintenance[]> =>
  request("GET", `${personalAgentApiBase(assistantId)}/maintenance`);

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
