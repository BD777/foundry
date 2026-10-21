import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextPatch } from "../dist/knowledge/context-patches.js";
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "context-patch-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = {
    workspaceId: "w",
    operationId: "one",
    action: "apply",
    path: "AGENTS.md",
    baseHash: "missing",
    content: "# Synthetic workspace\n",
  };
  return {
    root,
    run: (change = {}) => contextPatch(root, { ...base, ...change }),
  };
}
test("reviewed context applies once and late replay cannot undo new edits", (t) => {
  const { root, run } = fixture(t);
  const first = run();
  assert.equal(first.state, "applied");
  assert.equal(run().hash, first.hash);
  writeFileSync(join(root, "AGENTS.md"), "Person edited later\n");
  assert.equal(run().state, "applied");
  assert.equal(
    readFileSync(join(root, "AGENTS.md"), "utf8"),
    "Person edited later\n",
  );
  assert.throws(() => run({ content: "different" }), {
    code: "idempotency_conflict",
  });
});
test("stale base yields durable conflict, never overwrites", (t) => {
  const { root, run } = fixture(t);
  writeFileSync(join(root, "AGENTS.md"), "existing");
  assert.equal(run().state, "conflict");
  assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), "existing");
  assert.equal(run().state, "conflict");
});
test("prepared receipt recovers a write whose acknowledgement was lost", (t) => {
  const { root, run } = fixture(t);
  const result = run();
  const file = join(root, ".foundry/context-patches/one.json");
  const receipt = JSON.parse(readFileSync(file, "utf8"));
  receipt.state = "prepared";
  writeFileSync(file, JSON.stringify(receipt));
  assert.equal(run().hash, result.hash);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).state, "applied");
});
test("patches never follow source or receipt symlinks and cannot target arbitrary files", (t) => {
  const { root, run } = fixture(t);
  assert.throws(() => run({ path: ".env" }), { code: "invalid_request" });
  writeFileSync(join(root, "outside"), "do not touch");
  symlinkSync(join(root, "outside"), join(root, "AGENTS.md"));
  assert.throws(() => run(), { code: "unsafe_file" });
  assert.equal(readFileSync(join(root, "outside"), "utf8"), "do not touch");
});
