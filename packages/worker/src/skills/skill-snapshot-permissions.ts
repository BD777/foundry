import { chmodSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** A directory's write bit controls unlink/rename. Keep file bytes read-only
 * even while retiring a generation. Never change a linked target's mode.
 */
export function setDirectoryWriteAccess(path: string, writable: boolean): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) return;
  if (writable && !(stat.mode & 0o200)) chmodSync(path, 0o700);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory())
      setDirectoryWriteAccess(join(path, entry.name), writable);
  }
  if (!writable) chmodSync(path, 0o500);
}

/** Remove an owned tree, including state roots containing sealed generations. */
export function removeSkillSnapshotTree(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
    return;
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code !== "EACCES" && code !== "EPERM") throw error;
  }
  setDirectoryWriteAccess(path, true);
  rmSync(path, { recursive: true, force: true });
}
