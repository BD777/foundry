import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A path inside this worker package (the directory holding package.json,
 * dist/, skills/ and scripts/). This file sits at dist/platform/, so the
 * answer does not depend on where its caller lives.
 */
export function workerPackagePath(...segments: string[]): string {
  return resolve(
    fileURLToPath(new URL("../../", import.meta.url)),
    ...segments,
  );
}
