import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentSession,
  AgentSubagentSummary,
} from "@bd777/foundry-protocol";
import {
  foundryStreamEpoch,
  foundryStreamOpened,
  isFoundryStreamOpen,
  listAgentSubagents,
  subscribeFoundryEvents,
  type AgentSubagentsResult,
  type FoundryStreamLifecycle,
} from "../../api";
import type { AgentSubagentUpdate } from "../../api-types";
import {
  applySubagentUpdate,
  subagentActivity,
  subagentFetchDelay,
  subagentReadDelay,
  type SubagentActivity,
} from "./chat-subagent-policy";

/** The event stream as subagent lists use it; tests replace it. */
export interface SubagentStream {
  subscribe: (
    onUpdate: (update: AgentSubagentUpdate) => void,
    lifecycle: FoundryStreamLifecycle,
  ) => () => void;
  isOpen: () => boolean;
  /** See foundryStreamEpoch. */
  epoch: () => number;
  /** See foundryStreamOpened. */
  opened: () => Promise<boolean>;
}

export const subagentStream: SubagentStream = {
  subscribe: (onUpdate, lifecycle) =>
    subscribeFoundryEvents((event) => {
      if (event.type === "agent_subagent_updated") onUpdate(event.payload);
    }, lifecycle),
  isOpen: isFoundryStreamOpen,
  epoch: foundryStreamEpoch,
  opened: foundryStreamOpened,
};

interface SessionFetchState {
  etag?: string;
  /** The stream epoch the list held was read at; undefined: none held. */
  epoch?: number;
  /** An update said the list must be read again. */
  stale: boolean;
  failed: boolean;
  /** Reads that failed in a row; their retries back off. */
  failures?: number;
  /** Updates that arrived while a read ran: applied over its answer. */
  pushed?: AgentSubagentSummary[];
  fetchedRevision?: string;
  endedAtFetch?: number;
  inFlight: boolean;
  lastFetchAt?: number;
  timer?: ReturnType<typeof setTimeout>;
  /** When `timer` fires. */
  dueAt?: number;
}

export interface ChatSubagents {
  bySession: Readonly<Record<string, AgentSubagentSummary[]>>;
  /** What subagents answered: kept out of the main transcript. */
  responseTexts: ReadonlySet<string>;
  /** The last refresh failed; the list shown is the last one fetched. */
  failed: boolean;
  retry: () => void;
}

/**
 * The selected chat's subagent lists. A session's list is read once it
 * shows subagents, then the stream's per-subagent updates keep it current:
 * it is read again only when the stream may have missed some (a new epoch),
 * when an update asks for it, on retry and, while the stream is down, as
 * subagents start and end (see subagentFetchDelay). One request per session
 * at a time, with the list's ETag. A failed read keeps the list shown.
 */
export function useChatSubagents({
  panelVisible,
  sessions,
  workspaceId,
  list = listAgentSubagents,
  stream = subagentStream,
}: {
  panelVisible: boolean;
  sessions: readonly AgentSession[];
  workspaceId: string;
  list?: (
    sessionId: string,
    options: { etag?: string; signal: AbortSignal },
  ) => Promise<AgentSubagentsResult>;
  stream?: SubagentStream;
}): ChatSubagents {
  const [bySession, setBySession] = useState<
    Record<string, AgentSubagentSummary[]>
  >({});
  const [failedSessions, setFailedSessions] = useState<Record<string, boolean>>(
    {},
  );
  const [streamOpen, setStreamOpen] = useState(stream.isOpen);
  const fetches = useRef(new Map<string, SessionFetchState>());
  const controller = useRef(new AbortController());
  const [retries, setRetries] = useState(0);
  const schedule = useRef<(sessionId: string) => void>(() => undefined);

  const activities = sessions.map((session) => ({
    id: session.id,
    activity: subagentActivity(session),
  }));
  // A string of short revisions: the effect runs when one of them changes.
  const key = activities
    .map(({ id, activity }) =>
      activity ? `${id}:${activity.revision}:${activity.running ? 1 : 0}` : "",
    )
    .join("|");
  const activitiesRef = useRef(activities);
  activitiesRef.current = activities;
  const panelVisibleRef = useRef(panelVisible);
  panelVisibleRef.current = panelVisible;
  const streamOpenRef = useRef(streamOpen);
  streamOpenRef.current = streamOpen;
  const workspaceRef = useRef(workspaceId);
  workspaceRef.current = workspaceId;

  useEffect(() => {
    const current = controller.current;
    const states = fetches.current;
    return () => {
      current.abort();
      states.forEach((state) => clearTimeout(state.timer));
      states.clear();
      controller.current = new AbortController();
      setBySession({});
      setFailedSessions({});
    };
  }, [workspaceId]);

  useEffect(() => {
    const activityOf = (sessionId: string) =>
      activitiesRef.current.find((item) => item.id === sessionId)?.activity;
    const delayOf = (
      state: SessionFetchState,
      activity: SubagentActivity | undefined,
      now: number,
    ) => {
      if (!streamOpenRef.current) {
        return subagentFetchDelay({
          activity,
          panelVisible: panelVisibleRef.current,
          fetchedRevision: state.fetchedRevision,
          endedAtFetch: state.endedAtFetch,
          failed: state.failed,
          failures: state.failures,
          inFlight: state.inFlight,
          lastFetchAt: state.lastFetchAt,
          now,
        });
      }
      const current =
        state.epoch === stream.epoch() && !state.stale && !state.failed;
      // Updates keep the list current: once the stream is down, only
      // subagents starting or ending after now need a read.
      if (current && activity) {
        state.fetchedRevision = activity.revision;
        state.endedAtFetch = activity.ended;
      }
      return subagentReadDelay({
        activity,
        panelVisible: panelVisibleRef.current,
        current,
        failed: state.failed,
        failures: state.failures,
        endedAtFetch: state.endedAtFetch,
        inFlight: state.inFlight,
        lastFetchAt: state.lastFetchAt,
        now,
      });
    };
    const read = (sessionId: string, state: SessionFetchState) => {
      const activity = activityOf(sessionId);
      state.inFlight = true;
      state.stale = false;
      state.pushed = [];
      state.lastFetchAt = Date.now();
      // Also when it fails: its retry waits for the interval.
      if (activity) state.endedAtFetch = activity.ended;
      const revision = activity?.revision;
      const signal = controller.current.signal;
      void (async () => {
        try {
          // Started once the stream is open, the read misses no update.
          await stream.opened();
          if (signal.aborted) return;
          const epoch = stream.epoch();
          const result = await list(sessionId, { etag: state.etag, signal });
          if (signal.aborted) return;
          state.etag = result.etag;
          state.epoch = epoch;
          state.failed = false;
          state.failures = 0;
          state.fetchedRevision = revision;
          if (result.subagents) {
            const subagents = (state.pushed ?? []).reduce(
              applySubagentUpdate,
              result.subagents,
            );
            setBySession((value) => ({ ...value, [sessionId]: subagents }));
          }
          setFailedSessions((value) =>
            value[sessionId] ? { ...value, [sessionId]: false } : value,
          );
        } catch {
          if (signal.aborted) return;
          // Keep what is shown; the retry (or the next change) asks again.
          state.failed = true;
          state.failures = (state.failures ?? 0) + 1;
          setFailedSessions((value) => ({ ...value, [sessionId]: true }));
        } finally {
          state.inFlight = false;
          state.pushed = undefined;
          if (!signal.aborted) schedule.current(sessionId);
        }
      })();
    };
    schedule.current = (sessionId: string) => {
      const state = fetches.current.get(sessionId) ?? {
        inFlight: false,
        stale: false,
        failed: false,
      };
      fetches.current.set(sessionId, state);
      const now = Date.now();
      const delay = delayOf(state, activityOf(sessionId), now);
      if (delay === undefined) return;
      // A read already due no later stands; one due sooner replaces it.
      if (state.timer !== undefined) {
        if (state.dueAt !== undefined && state.dueAt <= now + delay) return;
        clearTimeout(state.timer);
      }
      state.dueAt = now + delay;
      state.timer = setTimeout(() => {
        state.timer = undefined;
        state.dueAt = undefined;
        // What is due may have changed meanwhile: the panel closed, the
        // stream went down or an update made the list current.
        const due = delayOf(state, activityOf(sessionId), Date.now());
        if (due === 0) read(sessionId, state);
        else if (due !== undefined) schedule.current(sessionId);
      }, delay);
    };
    activitiesRef.current.forEach(({ id }) => schedule.current(id));
  }, [key, panelVisible, retries, list, stream, streamOpen]);

  useEffect(
    () =>
      stream.subscribe(
        (update) => {
          if (update.workspaceId !== workspaceRef.current) return;
          const state = fetches.current.get(update.sessionId);
          // A list neither held nor being read is read when it is shown.
          if (!state || (state.epoch === undefined && !state.inFlight)) return;
          const subagent = update.subagent;
          if (!subagent) {
            state.stale = true;
            schedule.current(update.sessionId);
            return;
          }
          state.pushed?.push(subagent);
          if (state.epoch === undefined) return;
          setBySession((value) => {
            const held = value[update.sessionId];
            if (!held) return value;
            const next = applySubagentUpdate(held, subagent);
            return next === held
              ? value
              : { ...value, [update.sessionId]: next };
          });
        },
        {
          onOpen: () => setStreamOpen(true),
          onError: () => setStreamOpen(false),
          onResync: () =>
            activitiesRef.current.forEach(({ id }) => schedule.current(id)),
        },
      ),
    [stream],
  );

  const retry = useCallback(() => {
    activitiesRef.current.forEach(({ id }) => {
      const state = fetches.current.get(id);
      if (!state) return;
      state.stale = true;
      state.failures = 0;
      state.fetchedRevision = undefined;
      state.endedAtFetch = undefined;
      state.lastFetchAt = undefined;
    });
    setRetries((value) => value + 1);
  }, []);
  const sessionIds = activities.map(({ id }) => id).join("|");
  const failed = useMemo(
    () => sessionIds.split("|").some((id) => failedSessions[id]),
    [failedSessions, sessionIds],
  );
  const responseTexts = useMemo(
    () =>
      new Set(
        Object.values(bySession)
          .flatMap((subagents) =>
            subagents.flatMap((subagent) => subagent.responseTexts),
          )
          .map((text) => text.trim())
          .filter(Boolean),
      ),
    [bySession],
  );
  return { bySession, failed, responseTexts, retry };
}
