// Tests that prepare native launch plans need writable transcript sources even
// on a fresh CI machine. Keep the launcher's protection of real homes intact.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "native-test-homes-"));
process.env.CODEX_HOME = join(root, "codex");
process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
mkdirSync(process.env.CODEX_HOME);
mkdirSync(process.env.CLAUDE_CONFIG_DIR);
test.after(() => rmSync(root, { recursive: true, force: true }));
