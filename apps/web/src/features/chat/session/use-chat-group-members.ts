import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentSession } from "@bd777/foundry-protocol";
import { getChatGroupMemberCounts, getChatGroupMembers } from "../../../api";

interface GroupMemberState {
  workspaceId: string;
  /** Each folder's listable chats, from the server. */
  counts: Record<string, number>;
  /** The chats read on demand, newest first, in the order they arrived. */
  sessions: AgentSession[];
  /** The cursor that reads a folder's next page; "" until its first page. */
  cursors: Record<string, string>;
  loading: Record<string, boolean>;
  /** The folder has added at least one page of its older chats. */
  loaded: Record<string, boolean>;
  /** A page ended with no next cursor: the folder has no more to add. */
  exhausted: Record<string, boolean>;
}

function emptyState(workspaceId: string): GroupMemberState {
  return {
    workspaceId,
    counts: {},
    sessions: [],
    cursors: {},
    loading: {},
    loaded: {},
    exhausted: {},
  };
}

/**
 * A folder's chats the chat list's own window leaves out (it reads the newest
 * 80 sessions). The list knows each folder's count and reads one page when the
 * person expands it, so the folder never silently hides a member: the count
 * and the archive dialog's own list agree.
 */
export function useChatGroupMembers(workspaceId: string, active: boolean) {
  const [state, setState] = useState<GroupMemberState>(() =>
    emptyState(workspaceId),
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    setState((current) =>
      current.workspaceId === workspaceId ? current : emptyState(workspaceId),
    );
  }, [workspaceId]);
  useEffect(() => {
    if (!active || !workspaceId) return;
    let cancelled = false;
    const controller = new AbortController();
    void getChatGroupMemberCounts(workspaceId, { signal: controller.signal })
      .then((counts) => {
        if (cancelled) return;
        setState((current) =>
          current.workspaceId === workspaceId
            ? { ...current, counts }
            : current,
        );
      })
      .catch(() => {
        // The list still shows what it holds; the older row simply waits.
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [active, workspaceId, revision]);
  const load = useCallback(
    (groupId: string) => {
      const current = stateRef.current;
      if (
        current.workspaceId !== workspaceId ||
        current.loading[groupId] ||
        current.exhausted[groupId]
      ) {
        return;
      }
      const cursor = current.cursors[groupId] ?? "";
      setState((now) => ({
        ...now,
        loading: { ...now.loading, [groupId]: true },
      }));
      void getChatGroupMembers(workspaceId, groupId, cursor)
        .then((page) => {
          setState((now) => {
            if (now.workspaceId !== workspaceId) return now;
            const known = new Set(now.sessions.map((session) => session.id));
            return {
              ...now,
              sessions: [
                ...now.sessions,
                ...page.sessions.filter((session) => !known.has(session.id)),
              ],
              cursors: { ...now.cursors, [groupId]: page.nextCursor },
              loading: { ...now.loading, [groupId]: false },
              loaded: { ...now.loaded, [groupId]: true },
              exhausted: { ...now.exhausted, [groupId]: !page.nextCursor },
            };
          });
        })
        .catch(() => {
          setState((now) => ({
            ...now,
            loading: { ...now.loading, [groupId]: false },
          }));
        });
    },
    [workspaceId],
  );
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  return {
    counts: state.counts,
    sessions: state.sessions,
    loading: state.loading,
    loaded: state.loaded,
    exhausted: state.exhausted,
    load,
    refresh,
  };
}
