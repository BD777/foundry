import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? sources(path)
      : /\.tsx?$/.test(name)
        ? [path]
        : [];
  });
}

test("only the execution default fields read worker groups, so chat model pickers never offer one", () => {
  const readers = sources(new URL("../src", import.meta.url).pathname).filter(
    (file) => /listWorkerGroups\(/.test(readFileSync(file, "utf8")),
  );
  assert.deepEqual(readers.map((file) => file.split("/src/")[1]).sort(), [
    "api/worker-groups.ts",
    "components/workspace/execution-default-fields.tsx",
    "features/profiles/unlinked-models.tsx",
    "features/profiles/worker-groups-section.tsx",
  ]);
});
