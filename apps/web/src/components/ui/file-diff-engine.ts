import { createTwoFilesPatch } from "diff";
export function createFileDiff(
  before: string,
  after: string,
): { patch?: string; error?: string } {
  if (
    before.split("\n").some((line) => line.length > 20000) ||
    after.split("\n").some((line) => line.length > 20000)
  )
    return {
      error:
        "This file contains very long lines. Download the archives for external comparison.",
    };
  if (before.length + after.length > 1024 * 1024)
    return {
      error:
        "This file is too large for inline diff. Download the archives for the complete contents.",
    };
  const patch = createTwoFilesPatch(
    "a/server",
    "b/local",
    before,
    after,
    "",
    "",
    { context: 3, timeout: 800, maxEditLength: 12000 },
  );
  if (!patch)
    return {
      error:
        "Diff computation reached its time limit. Download the archives to compare externally.",
    };
  if (patch.split("\n").length > 5000)
    return {
      error:
        "This diff has more than 5,000 lines. Download the archives to inspect all changes.",
    };
  return { patch: "diff --git a/server b/local\n" + patch };
}
