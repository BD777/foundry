import type { AgentSessionEvent } from "@bd777/foundry-protocol";

// i18n-ignore: protocol event label the worker emits, never shown as copy
const responseStreamLabel = "Response stream";

/**
 * A session's events are kept as plain arrays (the protocol shape every
 * consumer reads), each with a key → position index on the side. Arrays
 * derived by appending or replacing share their parent's index, so a merge
 * costs O(1) amortized lookups; every lookup is validated against the array,
 * and a stale answer (a sibling array changed the shared index) rebuilds
 * that array's own index.
 */
const indexes = new WeakMap<
  readonly AgentSessionEvent[],
  Map<string, number>
>();

/** Lists known to need no normalization: every list this module returns. */
const normalized = new WeakMap<
  readonly AgentSessionEvent[],
  AgentSessionEvent[]
>();

function normal(events: AgentSessionEvent[]): AgentSessionEvent[] {
  normalized.set(events, events);
  return events;
}

function responseStreamOrder(id: string): number | undefined {
  const match = id.match(/_response_stream(?:_(\d+))?$/);
  if (!match) return undefined;
  const suffix = match[1];
  if (!suffix) return 1;
  const order = Number(suffix);
  return Number.isSafeInteger(order) && order > 0 ? order : undefined;
}

function isResponseEvent(event: AgentSessionEvent): boolean {
  return event.message
    ? event.message.kind === "assistant"
    : event.label === responseStreamLabel;
}

const legacyStreamKey = (sessionId: string) => `rs-legacy:${sessionId}`;

/**
 * What makes two events the same transcript item: an assistant message by
 * its message id, a legacy response stream (an id without a stream ordinal)
 * as the session's one stream, anything else by its event id.
 */
export function agentEventKey(event: AgentSessionEvent): string {
  if (event.message) {
    return event.message.kind === "assistant"
      ? `m:${event.sessionId}:${event.message.id}`
      : `id:${event.id}`;
  }
  if (
    event.label === responseStreamLabel &&
    responseStreamOrder(event.id) === undefined
  ) {
    return legacyStreamKey(event.sessionId);
  }
  return `id:${event.id}`;
}

function buildIndex(events: readonly AgentSessionEvent[]): Map<string, number> {
  const index = new Map<string, number>();
  events.forEach((event, position) =>
    index.set(agentEventKey(event), position),
  );
  indexes.set(events, index);
  return index;
}

function indexFor(events: readonly AgentSessionEvent[]): Map<string, number> {
  return indexes.get(events) ?? buildIndex(events);
}

/** Position of the event with `key`, or -1. */
export function eventPosition(
  events: readonly AgentSessionEvent[],
  key: string,
): number {
  let position = indexFor(events).get(key);
  if (position === undefined) return -1;
  const candidate = events[position];
  if (candidate && agentEventKey(candidate) === key) return position;
  position = buildIndex(events).get(key);
  return position === undefined ? -1 : position;
}

/** Where an incoming response snapshot belongs, under the legacy rules. */
function responsePosition(
  events: readonly AgentSessionEvent[],
  incoming: AgentSessionEvent,
): number {
  const own = eventPosition(events, agentEventKey(incoming));
  if (own >= 0 || incoming.message) return own;
  const order = responseStreamOrder(incoming.id);
  if (order === 1) {
    // The first ordinal continues a legacy stream of the same session.
    return eventPosition(events, legacyStreamKey(incoming.sessionId));
  }
  if (order === undefined) {
    // A legacy snapshot continues whatever stream came first.
    return events.findIndex(
      (candidate) =>
        !candidate.message && candidate.label === responseStreamLabel,
    );
  }
  return -1;
}

function withReplaced(
  events: readonly AgentSessionEvent[],
  position: number,
  incoming: AgentSessionEvent,
): AgentSessionEvent[] {
  const next = events.slice();
  next[position] = incoming;
  const index = indexFor(events);
  index.set(agentEventKey(incoming), position);
  indexes.set(next, index);
  return normal(next);
}

function withAppended(
  events: readonly AgentSessionEvent[],
  incoming: AgentSessionEvent,
): AgentSessionEvent[] {
  const next = events.slice();
  next.push(incoming);
  const index = indexFor(events);
  index.set(agentEventKey(incoming), events.length);
  indexes.set(next, index);
  return normal(next);
}

/**
 * Adds one live event. A response snapshot replaces its stream where it
 * started; another event with a known id moves to the end, where the server
 * now orders it.
 */
export function appendAgentEvent(
  events: readonly AgentSessionEvent[] | undefined,
  incoming: AgentSessionEvent,
): AgentSessionEvent[] {
  const current = events ?? [];
  if (isResponseEvent(incoming)) {
    const position = responsePosition(current, incoming);
    return position < 0
      ? withAppended(current, incoming)
      : withReplaced(current, position, incoming);
  }
  const position = eventPosition(current, agentEventKey(incoming));
  if (position < 0) return withAppended(current, incoming);
  if (position === current.length - 1) {
    return withReplaced(current, position, incoming);
  }
  // Rare (the same event sent again): positions shift, so a fresh index.
  const next = current.filter((_, index) => index !== position);
  next.push(incoming);
  buildIndex(next);
  return normal(next);
}

/**
 * Adds a burst of live events (one animation frame's worth) with a single
 * copy of the list: O(n + k) for k events, not O(n · k).
 */
export function appendAgentEvents(
  events: readonly AgentSessionEvent[] | undefined,
  incoming: readonly AgentSessionEvent[],
): AgentSessionEvent[] {
  const current = events ?? [];
  if (incoming.length === 0) return current as AgentSessionEvent[];
  if (incoming.length === 1) return appendAgentEvent(current, incoming[0]!);
  const next: (AgentSessionEvent | undefined)[] = current.slice();
  const index = new Map(indexFor(current));
  const find = (key: string): number => {
    const position = index.get(key);
    return position !== undefined &&
      next[position] !== undefined &&
      agentEventKey(next[position]!) === key
      ? position
      : -1;
  };
  let moved = false;
  for (const event of incoming) {
    const key = agentEventKey(event);
    let position = find(key);
    if (isResponseEvent(event)) {
      if (position < 0 && !event.message) {
        const order = responseStreamOrder(event.id);
        if (order === 1) position = find(legacyStreamKey(event.sessionId));
        else if (order === undefined)
          position = next.findIndex(
            (candidate) =>
              candidate !== undefined &&
              !candidate.message &&
              candidate.label === responseStreamLabel,
          );
      }
      if (position >= 0) {
        next[position] = event;
        index.set(key, position);
        continue;
      }
    } else if (position >= 0 && position !== next.length - 1) {
      next[position] = undefined;
      moved = true;
    } else if (position >= 0) {
      next[position] = event;
      continue;
    }
    index.set(key, next.length);
    next.push(event);
  }
  if (moved) {
    const compact = next.filter(
      (event): event is AgentSessionEvent => event !== undefined,
    );
    buildIndex(compact);
    return normal(compact);
  }
  indexes.set(next as AgentSessionEvent[], index);
  return normal(next as AgentSessionEvent[]);
}

/**
 * Collapses a persisted event list in one pass: response snapshots into
 * their stream, repeated ids into their last copy. The same input array
 * returns the same result, and an already normal list is returned as is.
 */
export function normalizeAgentEvents(
  events: readonly AgentSessionEvent[] | undefined,
): AgentSessionEvent[] {
  if (!events) return [];
  const cached = normalized.get(events);
  if (cached) return cached;
  const result: (AgentSessionEvent | undefined)[] = [];
  const positions = new Map<string, number>();
  let firstStream = -1;
  let changed = false;
  for (const event of events) {
    const key = agentEventKey(event);
    let position = positions.get(key);
    if (position === undefined && isResponseEvent(event) && !event.message) {
      const order = responseStreamOrder(event.id);
      if (order === 1) {
        position = positions.get(legacyStreamKey(event.sessionId));
      } else if (order === undefined && firstStream >= 0) {
        position = firstStream;
      }
    }
    if (position !== undefined && result[position] !== undefined) {
      changed = true;
      if (isResponseEvent(event)) {
        result[position] = event;
        positions.set(key, position);
        continue;
      }
      result[position] = undefined;
    }
    positions.set(key, result.length);
    if (
      firstStream < 0 &&
      !event.message &&
      event.label === responseStreamLabel
    )
      firstStream = result.length;
    result.push(event);
  }
  const output = changed
    ? result.filter((event): event is AgentSessionEvent => event !== undefined)
    : (events as AgentSessionEvent[]);
  if (output !== events) normalized.set(events, output);
  normalized.set(output, output);
  return output;
}

function sameEvent(left: AgentSessionEvent, right: AgentSessionEvent): boolean {
  if (left === right) return true;
  if (
    left.id !== right.id ||
    left.at !== right.at ||
    left.label !== right.label ||
    left.detail !== right.detail ||
    left.level !== right.level ||
    left.message?.text !== right.message?.text ||
    left.message?.status !== right.message?.status ||
    Boolean(left.metadata) !== Boolean(right.metadata)
  ) {
    return false;
  }
  return (
    !left.metadata ||
    JSON.stringify(left.metadata) === JSON.stringify(right.metadata)
  );
}

/**
 * Merges a server snapshot (the whole list, or its most recent window) into
 * what is shown, append-only: the snapshot adds and updates events in its own
 * order, and an event only this view has (newer than the snapshot, or older
 * than its window) keeps its place next to its neighbours. Nothing shown is
 * ever dropped. Linear in both lengths; unchanged events keep their objects
 * and an unchanged list keeps its identity.
 */
export function reconcileAgentEvents(
  local: readonly AgentSessionEvent[] | undefined,
  snapshot: readonly AgentSessionEvent[],
): AgentSessionEvent[] {
  const incoming = normalizeAgentEvents(snapshot);
  if (!local || local.length === 0) return incoming;
  if (incoming.length === 0) return local as AgentSessionEvent[];
  const incomingPositions = new Map<string, number>();
  incoming.forEach((event, position) =>
    incomingPositions.set(agentEventKey(event), position),
  );
  // Events only this view has, attached to the shared event before them.
  const leading: AgentSessionEvent[] = [];
  const following = new Map<number, AgentSessionEvent[]>();
  const localByKey = new Map<string, AgentSessionEvent>();
  let anchor = -1;
  for (const event of local) {
    const key = agentEventKey(event);
    const position = incomingPositions.get(key);
    if (position !== undefined) {
      localByKey.set(key, event);
      anchor = position;
      continue;
    }
    if (anchor < 0) leading.push(event);
    else {
      const list = following.get(anchor);
      if (list) list.push(event);
      else following.set(anchor, [event]);
    }
  }
  const output: AgentSessionEvent[] = [];
  const shared = localByKey.size > 0;
  // Without a shared event, time decides whether the view's own events are
  // older (a window that ends before them) or newer (a late snapshot).
  const leadingFirst =
    shared || leading.length === 0
      ? true
      : (Date.parse(leading[leading.length - 1]!.at) || 0) <=
        (Date.parse(incoming[0]!.at) || 0);
  if (leadingFirst) output.push(...leading);
  incoming.forEach((event, position) => {
    const known = localByKey.get(agentEventKey(event));
    output.push(known && sameEvent(known, event) ? known : event);
    const after = following.get(position);
    if (after) output.push(...after);
  });
  if (!leadingFirst) output.push(...leading);
  if (
    output.length === local.length &&
    output.every((event, index) => event === local[index])
  ) {
    return local as AgentSessionEvent[];
  }
  buildIndex(output);
  return normal(output);
}

/** Adds an older page before what is shown, skipping events already there. */
export function prependOlderAgentEvents(
  local: readonly AgentSessionEvent[] | undefined,
  older: readonly AgentSessionEvent[],
): AgentSessionEvent[] {
  const current = local ?? [];
  const page = normalizeAgentEvents(older).filter(
    (event) => eventPosition(current, agentEventKey(event)) < 0,
  );
  if (page.length === 0) return current as AgentSessionEvent[];
  const output = [...page, ...current];
  buildIndex(output);
  return normal(output);
}
