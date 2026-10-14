// Preloaded into every test file's process: `node --test` runs the files in
// parallel, so each gets its own state root under the run's scratch one, and
// files that rewrite the same registry cannot race. Runs before the file's
// imports, which fix their state paths when they load.
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";

const base = process.env.FOUNDRY_STATE_ROOT;
const file = process.argv[1];
if (base && file?.endsWith(".test.mjs")) {
  const root = join(base, basename(file, ".test.mjs"));
  mkdirSync(root, { recursive: true });
  process.env.FOUNDRY_STATE_ROOT = root;
}
