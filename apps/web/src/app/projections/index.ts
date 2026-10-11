// What live events do to the workspace data, by event type, and how a
// read's answer merges with what they changed. Each domain declares its
// types' slices, the kinds of entity its events touch and how it merges the
// fields it owns (stream-projection.ts); the live-data layer, the read merge
// and the touch ledger look them up here. A type no domain declares changes
// nothing in the workspace data: its feature follows it.

import type { FoundryStreamEvent } from "../../api-types";
import { chatLoadedMerges, chatProjections, chatTouchKinds } from "./chats";
import { dataChangeProjections } from "./data-changes";
import {
  deviceLoadedMerges,
  deviceProjections,
  deviceTouchKinds,
} from "./devices";
import { issueLoadedMerges, issueProjections, issueTouchKinds } from "./issues";
import {
  sessionLoadedMerges,
  sessionProjections,
  sessionTouchKinds,
} from "./sessions";
import type {
  LoadedMerges,
  StreamEventType,
  StreamProjection,
  StreamProjections,
  StreamRead,
  StreamReadView,
} from "./stream-projection";

const projections: StreamProjections = {
  ...sessionProjections,
  ...issueProjections,
  ...deviceProjections,
  ...chatProjections,
  ...dataChangeProjections,
};

/** The kinds of entity live events touch (StreamProjection.touches). */
export const touchKinds = [
  ...deviceTouchKinds,
  ...issueTouchKinds,
  ...sessionTouchKinds,
  ...chatTouchKinds,
] as const;

export type TouchKind = (typeof touchKinds)[number];

/** How a read's answer merges, by field (see mergeLoadedFoundryData). */
export const loadedMerges: LoadedMerges = {
  ...deviceLoadedMerges,
  ...issueLoadedMerges,
  ...sessionLoadedMerges,
  ...chatLoadedMerges,
};

/** The slice of an event type; undefined when the data does not follow it. */
export function streamProjection<K extends StreamEventType>(
  type: K,
): StreamProjection<K> | undefined {
  return projections[type] as StreamProjection<K> | undefined;
}

/** What an event leaves that only a read of the data shown can show. */
export function streamEventReads(
  event: FoundryStreamEvent,
  view: StreamReadView,
): StreamRead | undefined {
  return streamProjection(event.type)?.reads?.(event.payload, view);
}

/** The entities an event changes in the workspace data. */
export function streamEventTouches(event: FoundryStreamEvent) {
  return streamProjection(event.type)?.touches?.(event.payload) ?? [];
}

export type {
  StreamTouches,
  StreamEventType,
  StreamProjection,
  StreamRead,
  StreamReadView,
} from "./stream-projection";
