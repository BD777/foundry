import type { BrowserEventPayloads } from "@bd777/foundry-protocol";
import type {
  FoundryData,
  FoundryDataField,
  FoundryStreamEvent,
} from "../../api-types";
import type { TouchKind } from "./index";

/** An event type the workspace data may follow (notices never reach it). */
export type StreamEventType = FoundryStreamEvent["type"];

/** The workspace data shown, as an event's read decision needs it. */
export interface StreamReadView {
  workspaceId: string;
  devices: FoundryData["devices"];
}

/**
 * A read of workspace data an event leaves: of `fields` (the default set
 * without them), once events have been quiet for `delayMs`.
 */
export interface StreamRead {
  delayMs: number;
  fields?: readonly FoundryDataField[];
}

/**
 * What the events of one type do to the workspace data. Each domain module
 * declares its types' slices; a type without one changes nothing here (its
 * feature follows it).
 */
export interface StreamProjection<K extends StreamEventType> {
  /**
   * Applies a run of consecutive events of this type, in order: one step
   * for the run, however many events it holds.
   */
  apply?: (
    data: FoundryData,
    payloads: readonly BrowserEventPayloads[K][],
  ) => FoundryData;
  /** What the event leaves that only a read of workspace data shows. */
  reads?: (
    payload: BrowserEventPayloads[K],
    view: StreamReadView,
  ) => StreamRead | undefined;
  /** The entities the event changes, which a read landing later keeps. */
  touches?: (
    payload: BrowserEventPayloads[K],
  ) => readonly (readonly [TouchKind, string])[];
  /** `next`, right after `previous`, makes applying `previous` needless. */
  supersedes?: (
    previous: BrowserEventPayloads[K],
    next: BrowserEventPayloads[K],
  ) => boolean;
}

export type StreamProjections = {
  [K in StreamEventType]?: StreamProjection<K>;
};

/**
 * What live events changed after a read started, by the kinds of entity
 * the slices' events touch (StreamProjection.touches).
 */
export type StreamTouches = Readonly<Record<TouchKind, ReadonlySet<string>>>;

/**
 * How a read's answer of one field merges over what is shown: what live
 * events changed after the read started (`touched`, absent when unknown)
 * is at least as new as the read. A field no slice merges is taken as read.
 */
export type LoadedMerge<F extends FoundryDataField> = (
  current: FoundryData,
  loaded: FoundryData,
  touched: StreamTouches | undefined,
) => FoundryData[F];

export type LoadedMerges = { [F in FoundryDataField]?: LoadedMerge<F> };

/**
 * Keeps what live events changed after a read started: the read may have
 * been served before them. `keep` entities stay as shown; one live events
 * touched (`live`) that the read does not list yet stays in front, as the
 * stream added it. The rest come back as the read has them, in its order.
 */
export function keepStreamed<T extends { id: string }>(
  current: readonly T[],
  merged: T[],
  keep: ReadonlySet<string> = new Set(),
  live: ReadonlySet<string> = keep,
): T[] {
  if (keep.size === 0 && live.size === 0) return merged;
  const shown = new Map(current.map((item) => [item.id, item]));
  const result = merged.map((item) =>
    keep.has(item.id) ? (shown.get(item.id) ?? item) : item,
  );
  const listed = new Set(merged.map((item) => item.id));
  const added = current.filter(
    (item) => live.has(item.id) && !listed.has(item.id),
  );
  return added.length > 0 ? [...added, ...result] : result;
}

/** `apply` for events that each change the data on their own. */
export function eachPayload<P>(
  applyOne: (data: FoundryData, payload: P) => FoundryData,
): (data: FoundryData, payloads: readonly P[]) => FoundryData {
  return (data, payloads) => payloads.reduce(applyOne, data);
}
