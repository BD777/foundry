import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentSession } from "@bd777/foundry-protocol";
import {
  getAgentSessionEventsAfter,
  getAgentSessionEventsBefore,
  getAgentSessionThread,
  type WindowedAgentSession,
} from "../../api";
import {
  foundryStreamEpoch,
  foundryStreamOpened,
  isFoundryStreamOpen,
  onStreamLifecycle,
} from "../../stream";
import {
  agentSessionBehindActivity,
  agentSessionLacksDetails,
} from "../../lib/agent-session-events";
import {
  createTranscriptLoader,
  transcriptWindowEvents,
  type TranscriptLoadState,
  type TranscriptLoaderTransport,
} from "./chat-transcript-loader";

export interface ChatTranscript {
  state: TranscriptLoadState;
  retry: () => void;
  loadEarlier: () => void;
}

/** Sessions whose transcript this tab loaded at least once. */
const loadedSessions = new Set<string>();

/**
 * Keeps the selected chat's transcript loaded: a recent window first (once
 * the stream opened), older pages on request, and a repair load (the events
 * after those held, see createTranscriptLoader) after a server resync or a
 * connection that could not resume, when what was loaded predates it, or —
 * while live events are not arriving — a gap the session summary reveals;
 * never by aborting a running load. A connection that
 * resumes replays what it missed, so it needs no load.
 */
export function useChatTranscript({
  onLoaded,
  sessions,
  threadId,
  workspaceId,
  transport,
}: {
  onLoaded: (sessions: AgentSession[]) => void;
  sessions: readonly AgentSession[];
  threadId?: string;
  workspaceId: string;
  transport?: TranscriptLoaderTransport;
}): ChatTranscript {
  const [streamOpen, setStreamOpen] = useState(isFoundryStreamOpen);
  const [state, setState] = useState<TranscriptLoadState>({
    loading: false,
    slow: false,
    failed: false,
    earlier: {},
    loadingEarlier: false,
    earlierFailed: false,
  });
  const latest = useRef({ onLoaded, workspaceId });
  latest.current = { onLoaded, workspaceId };
  const loaderRef =
    useRef<ReturnType<typeof createTranscriptLoader>>(undefined);
  loaderRef.current ??= createTranscriptLoader({
    transport: transport ?? {
      loadRecent: (id, options) =>
        getAgentSessionThread(id, latest.current.workspaceId, {
          ...options,
          eventsLimit: transcriptWindowEvents,
        }),
      loadEarlier: (sessionId, before, signal) =>
        getAgentSessionEventsBefore(sessionId, before, {
          eventsLimit: transcriptWindowEvents,
          signal,
        }),
      // A repair costs at most a window: more than that reloads it.
      loadAfter: (sessionId, after, signal) =>
        getAgentSessionEventsAfter(sessionId, after, {
          eventsLimit: transcriptWindowEvents,
          signal,
        }),
    },
    onLoaded: (loaded: WindowedAgentSession[]) => {
      loaded.forEach((session) => loadedSessions.add(session.id));
      latest.current.onLoaded(loaded);
    },
    onState: setState,
    opened: foundryStreamOpened,
    epoch: foundryStreamEpoch,
  });
  const loader = loaderRef.current;
  const selection =
    threadId && workspaceId ? `${workspaceId}\n${threadId}` : "";

  useEffect(() => {
    if (!selection) return;
    loader.select(selection.split("\n")[1]);
    return () => loader.select(undefined);
  }, [loader, selection]);

  const missing = sessions.some(
    (session) =>
      session.events === undefined || !loadedSessions.has(session.id),
  );
  const stale =
    !missing &&
    sessions.some(
      (session) =>
        agentSessionLacksDetails(session) ||
        (!streamOpen && agentSessionBehindActivity(session)),
    );
  useEffect(() => {
    if (!selection) return;
    if (missing) loader.request("missing");
    else if (stale) loader.request("stale");
  }, [loader, selection, missing, stale]);

  useEffect(() => {
    if (!selection) return;
    setStreamOpen(isFoundryStreamOpen());
    return onStreamLifecycle({
      onError: () => setStreamOpen(false),
      onOpen: () => setStreamOpen(true),
      onResync: () => loader.request("resync"),
    });
  }, [loader, selection]);

  const retry = useCallback(() => loader.request("retry"), [loader]);
  const loadEarlier = useCallback(() => loader.loadEarlier(), [loader]);
  return { state, retry, loadEarlier };
}
