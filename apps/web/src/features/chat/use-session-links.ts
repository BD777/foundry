import { useEffect, useMemo, useState } from "react";
import type { SessionLink } from "@bd777/foundry-protocol";
import { getSessionLink, isNotFoundForCaller } from "../../api";
import type { NamedSessions } from "./chat-session-model";

// Named once per page: a session another chat links to rarely changes its
// title, and many chats name the same one (the assistant's conversation).
const named = new Map<string, SessionLink | null>();
const lookups = new Map<string, Promise<void>>();

function lookUp(id: string): Promise<void> {
  let lookup = lookups.get(id);
  if (!lookup) {
    lookup = getSessionLink(id)
      .then(
        (link) => {
          named.set(id, link);
        },
        (error: unknown) => {
          // Not viewable for this person, or gone: named nothing. Any other
          // failure is asked again by the next reader.
          if (isNotFoundForCaller(error)) named.set(id, null);
        },
      )
      .finally(() => lookups.delete(id));
    lookups.set(id, lookup);
  }
  return lookup;
}

/**
 * The server's names for the sessions `ids` lists (chatSessionLink reads
 * them): each asked for once, as the person may view it.
 */
export function useSessionLinks(ids: readonly string[]): NamedSessions {
  const key = ids.join("\n");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const missing = key ? key.split("\n").filter((id) => !named.has(id)) : [];
    if (missing.length === 0) return;
    let cancelled = false;
    void Promise.all(missing.map(lookUp)).then(() => {
      if (!cancelled) setVersion((value) => value + 1);
    });
    return () => {
      cancelled = true;
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
