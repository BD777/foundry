import type { FoundryDataChangedPayload } from "@bd777/foundry-protocol";
import type { StreamProjections } from "./stream-projection";

/** A `foundry_data_changed` burst is read once, after this quiet period. */
export const dataChangeRefreshDelayMs = 500;

/** Whether a `foundry_data_changed` concerns the workspace shown. */
export function dataChangeConcerns(
  payload: FoundryDataChangedPayload,
  workspaceId: string,
): boolean {
  return payload.workspaceId === "" || payload.workspaceId === workspaceId;
}

export const dataChangeProjections = {
  // Says only that a read is due: of the fields it names, or of any.
  foundry_data_changed: {
    reads: (payload, view) =>
      dataChangeConcerns(payload, view.workspaceId)
        ? {
            delayMs: dataChangeRefreshDelayMs,
            fields: payload.resources?.length ? payload.resources : undefined,
          }
        : undefined,
  },
} satisfies StreamProjections;
