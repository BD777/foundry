import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Whether `path` is inside `root`, not `root` itself. Both are resolved
 * first, and the comparison is by path segment: `/a/bc` is not inside `/a/b`,
 * and a name that merely begins with dots (`/a/..cache`) is inside `/a`.
 */
export function isInside(root: string, path: string): boolean {
  return relativeInside(relative(resolve(root), resolve(path)));
}

/**
 * Whether `path` is `root` or inside it, for checks where the root itself
 * counts: a sandbox or search root, a process working directory, an ancestor.
 */
export function within(root: string, path: string): boolean {
  const suffix = relative(resolve(root), resolve(path));
  return suffix === "" || relativeInside(suffix);
}

/** `path` relative to `root` when it is inside it (see isInside). */
export function insidePath(root: string, path: string): string | undefined {
  const suffix = relative(resolve(root), resolve(path));
  return relativeInside(suffix) ? suffix : undefined;
}

/** Whether a `relative()` result names a path strictly inside its base. */
export function relativeInside(suffix: string): boolean {
  return (
    suffix !== "" &&
    !isAbsolute(suffix) &&
    suffix !== ".." &&
    !suffix.startsWith(`..${sep}`)
  );
}

/** `~/…` for a path in the home folder, as a person types or reads it. */
export function tildePath(path: string, home = homedir()): string {
  if (resolve(path) === resolve(home)) return "~";
  const suffix = insidePath(home, path);
  return suffix === undefined ? path : `~${sep}${suffix}`;
}

export function canonical(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(resolve(path));
  if (parent === resolve(path)) throw new Error(`Cannot resolve ${path}`);
  return resolve(canonical(parent), relative(parent, resolve(path)));
}

/**
 * Whether two paths name the same place. Strings that differ only by a linked
 * parent (`/home/me` → `/data/home/me`) are the same folder; so are bind mounts
 * of one folder, which keep different real paths but share dev:ino.
 */
export function samePath(a: string, b: string): boolean {
  if (!a || !b) return false;
  const left = resolve(a);
  const right = resolve(b);
  if (left === right) return true;
  try {
    if (canonical(left) === canonical(right)) return true;
    const one = statSync(left);
    const two = statSync(right);
    return one.ino !== 0 && one.dev === two.dev && one.ino === two.ino;
  } catch {
    return false;
  }
}
