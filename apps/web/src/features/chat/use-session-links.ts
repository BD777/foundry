import { useEffect, useMemo, useState } from "react";
import type { SessionLink } from "@bd777/foundry-protocol";
import { getSessionLink, isNotFoundForCaller } from "../../api";
import type { NamedSessions } from "./chat-session-model";

// Many chats name the same parent. Share lookups, but refresh its title and
// archive state while it is displayed, including across workspace visits.
const named = new Map<string, SessionLink | null>();
const checkedAt = new Map<string, number>();
const refreshInterval = 15000;
const lookups = new Map<string, Promise<void>>();

function lookUp(id: string): Promise<void> {
  let lookup = lookups.get(id);
  if (!lookup) {
    lookup = getSessionLink(id)
      .then(
        (link) => {
          named.set(id, link);
          checkedAt.set(id, Date.now());
        },
        (error: unknown) => {
          // Not viewable for this person, or gone: named nothing. Any other
          // failure is asked again by the next reader.
          if (isNotFoundForCaller(error)) {
            named.set(id, null);
            checkedAt.set(id, Date.now());
          }
        },
      )
      .finally(() => lookups.delete(id));
    lookups.set(id, lookup);
  }
  return lookup;
}

/**
 * The server's names for the sessions `ids` lists (chatSessionLink reads
 * them): refreshed periodically, as the person may view it.
 */
export function useSessionLinks(ids: readonly string[]): NamedSessions {
  const key = ids.join("\n");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const linkedIds = key ? key.split("\n") : [];
    if (!linkedIds.length) return;
    let cancelled = false;
    const refresh = (force = false) => {
      const stale = linkedIds.filter(
        (id) =>
          force ||
          !named.has(id) ||
          Date.now() - (checkedAt.get(id) ?? 0) >= refreshInterval,
      );
      if (!stale.length) return;
      void Promise.all(stale.map(lookUp)).then(() => {
        if (!cancelled) setVersion((value) => value + 1);
      });
    };
    refresh();
    const timer = window.setInterval(() => refresh(true), refreshInterval);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [key]);
  return useMemo(() => {
    const result = new Map<string, SessionLink | null>();
    for (const id of key ? key.split("\n") : []) {
      const link = named.get(id);
      if (link !== undefined) result.set(id, link);
    }
    return result;
    // A new version: a lookup finished.
  }, [key, version]);
}
