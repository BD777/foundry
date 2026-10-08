/**
 * What to list while a folder path is typed: the directory to read on the
 * device and the partial name to match inside it.
 */
export interface WorkspacePathLookup {
  lookupPath: string;
  parentPath?: string;
  query: string;
}

function trimTrailingSlash(path: string): string {
  return path.replace(/\/+$/, "") || "/";
}

function parentPathFor(path: string): string | undefined {
  const normalized = trimTrailingSlash(path.trim());
  if (normalized === "/" || normalized === "~") return undefined;
  const slash = normalized.lastIndexOf("/");
  if (slash < 0) return undefined;
  return slash === 0 ? "/" : normalized.slice(0, slash);
}

export function workspacePathLookup(
  input: string,
): WorkspacePathLookup | undefined {
  const raw = input.trim();
  if (!raw) return undefined;
  if (raw.endsWith("/")) {
    const lookupPath = trimTrailingSlash(raw);
    return { lookupPath, parentPath: parentPathFor(lookupPath), query: "" };
  }
  const slash = raw.lastIndexOf("/");
  // A bare name is looked up in the home folder, never the daemon's cwd.
  if (slash < 0) return { lookupPath: "~", query: raw === "~" ? "" : raw };
  const lookupPath = slash === 0 ? "/" : raw.slice(0, slash);
  return {
    lookupPath,
    parentPath: parentPathFor(lookupPath),
    query: raw.slice(slash + 1),
  };
}

/** Case-insensitive subsequence match, so "prj" finds "projects". */
export function matchesFolderQuery(name: string, query: string): boolean {
  const source = name.toLowerCase();
  let found = 0;
  for (const char of source) {
    if (found < query.length && char === query[found]!.toLowerCase()) found++;
  }
  return found === query.length;
}
