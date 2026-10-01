import { createTwoFilesPatch } from "diff";

/** Why a diff could not be produced; the viewer turns it into copy. */
export type FileDiffError =
  "longLines" | "tooLarge" | "timeLimit" | "tooManyLines" | "failed";

export function createFileDiff(
  before: string,
  after: string,
): { patch?: string; error?: FileDiffError } {
  if (
    before.split("\n").some((line) => line.length > 20000) ||
    after.split("\n").some((line) => line.length > 20000)
  )
    return { error: "longLines" };
  if (before.length + after.length > 1024 * 1024) return { error: "tooLarge" };
  const patch = createTwoFilesPatch(
    "a/server",
    "b/local",
    before,
    after,
    "",
    "",
    { context: 3, timeout: 800, maxEditLength: 12000 },
  );
  if (!patch) return { error: "timeLimit" };
  if (patch.split("\n").length > 5000) return { error: "tooManyLines" };
  return { patch: "diff --git a/server b/local\n" + patch };
}
