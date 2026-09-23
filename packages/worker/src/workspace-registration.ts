import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/** The UI registers existing folders; CLI init may deliberately create one. */
export function existingWorkspaceFolder(path: string): string {
  if (!isAbsolute(path))
    throw new Error("Enter an absolute folder path on this device.");
  const resolved = resolve(path);
  let directory = false;
  try {
    directory = statSync(resolved).isDirectory();
  } catch {
    /* Report a useful, bounded error. */
  }
  if (!directory)
    throw new Error(
      "That folder does not exist or is not accessible on this device. Choose an existing folder.",
    );
  return resolved;
}
