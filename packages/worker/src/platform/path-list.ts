import { delimiter } from "node:path";

// A Foundry session's own folders (connector links in session-bin, pinned
// tools in .sessions) belong to that session's run only.
const sessionFolder = /\/(session-bin|\.sessions)\/[^/]+\/?$/;

export function isSessionPathEntry(entry: string): boolean {
  return sessionFolder.test(entry);
}

/** Entries in order, the first of each kept, empty ones dropped. */
export function joinPaths(...lists: Array<string | undefined>): string {
  const seen = new Set<string>();
  for (const list of lists)
    for (const entry of (list ?? "").split(delimiter))
      if (entry) seen.add(entry);
  return [...seen].join(delimiter);
}

/** A PATH for a long-lived service: no session folders, no repeats. */
export function servicePath(path: string): string {
  return joinPaths(
    path
      .split(delimiter)
      .filter((entry) => !isSessionPathEntry(entry))
      .join(delimiter),
  );
}
