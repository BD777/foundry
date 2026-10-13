import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

/** Whether `path` is `root` or inside it. */
export function within(root: string, path: string): boolean {
  const suffix = relative(resolve(root), resolve(path));
  return suffix === "" || relativeInside(suffix);
}

/** Whether a `relative()` result names a path strictly inside its base. */
export function relativeInside(suffix: string): boolean {
  return (
    suffix !== "" &&
    !isAbsolute(suffix) &&
    suffix !== ".." &&
    !suffix.startsWith("../")
  );
}

export function canonical(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(resolve(path));
  if (parent === resolve(path)) throw new Error(`Cannot resolve ${path}`);
  return resolve(canonical(parent), relative(parent, resolve(path)));
}
