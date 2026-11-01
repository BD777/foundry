import type { BrowserEventPayloads } from "@bd777/foundry-protocol";

/**
 * Hybrid events carry what changed, or say only that it changed (the server
 * could not name it): whoever keeps that state then reads it again. What
 * each one carries, and when it carries nothing, is decided here once.
 */
const carriers = {
  agent_subagent_updated: (payload) => payload.subagent,
  chat_layout_changed: (payload) => payload.layout,
  chat_titles_changed: (payload) =>
    payload.titles || payload.removed
      ? { titles: payload.titles ?? [], removed: payload.removed ?? [] }
      : undefined,
  // The whole device, as workspace data lists it to a viewer who does not
  // own it; an event the server could not attach it to says its status only.
  device_status_changed: (payload) =>
    payload.device?.id === payload.deviceId ? payload.device : undefined,
} satisfies {
  [K in keyof BrowserEventPayloads]?: (
    payload: BrowserEventPayloads[K],
  ) => unknown;
};

export type HybridEventType = keyof typeof carriers;

/** What a hybrid event of type `K` carries when it carries something. */
export type CarriedData<K extends HybridEventType> = NonNullable<
  ReturnType<(typeof carriers)[K]>
>;

/**
 * What a hybrid event carries; undefined when it says only that what it
 * names changed, which is then read again.
 */
export function carriedData<K extends HybridEventType>(
  type: K,
  payload: BrowserEventPayloads[K],
): CarriedData<K> | undefined {
  const carrier = carriers[type] as (
    payload: BrowserEventPayloads[K],
  ) => CarriedData<K> | undefined;
  return carrier(payload);
}
