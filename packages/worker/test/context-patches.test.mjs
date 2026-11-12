import assert from "node:assert/strict";
import test from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextPatch } from "../dist/workspace/knowledge/context-patches.js";
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "context-patch-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = {
    workspaceId: "w",
    operationId: "one",
    action: "apply",
    path: "AGENTS.md",
    baseHash: "",
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
test("new files create reviewed nested folders and never replace an existing file", (t) => {
  const { root, run } = fixture(t);
  const path = ".claude/skills/release/references/checklist.md";
  const result = run({ path, content: "# Release checklist\n" });
  assert.equal(result.state, "applied");
  assert.equal(readFileSync(join(root, path), "utf8"), "# Release checklist\n");
  assert.ok(existsSync(join(root, ".claude/skills/release/references")));

  const docs = "docs/operations/approval.md";
  mkdirSync(join(root, "docs/operations"), { recursive: true });
  writeFileSync(join(root, docs), "Person-authored approval\n");
  assert.equal(
    run({
      operationId: "two",
      path: docs,
      content: "# Proposed approval\n",
    }).state,
    "conflict",
  );
  assert.equal(
    readFileSync(join(root, docs), "utf8"),
    "Person-authored approval\n",
  );
});
test("context patch targets and parent folders cannot escape through links", (t) => {
  const { root, run } = fixture(t);
  mkdirSync(join(root, "docs"));
  const outside = join(root, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(root, "docs/link"), "dir");
  assert.throws(
    () =>
      run({
        path: "docs/link/AGENTS.md",
        content: "# must not escape\n",
      }),
    { code: "unsafe_file" },
  );
  assert.equal(existsSync(join(outside, "AGENTS.md")), false);
});
test("only reviewed project instruction, docs and skill paths are accepted", (t) => {
  const { run } = fixture(t);
  const allowed = [
    "README.md",
    "AGENTS.md",
    "apps/web/AGENTS.md",
    "packages/worker/src/AGENTS.md",
    "docs/release.md",
    "docs/operations/release.md",
    ".claude/skills/release/SKILL.md",
    ".claude/skills/release/references/checklist.md",
    ".agents/skills/release/SKILL.md",
    ".agents/skills/release/references/checklist.md",
  ];
  for (const path of allowed)
    assert.equal(run({ action: "read", path }).state, "read", path);
  const rejected = [
    "/tmp/AGENTS.md",
    "C:/AGENTS.md",
    "../AGENTS.md",
    "docs/../AGENTS.md",
    "docs//release.md",
    "docs/./release.md",
    ".git/AGENTS.md",
    "project/.git/AGENTS.md",
    ".foundry/AGENTS.md",
    "docs/release.txt",
    ".claude/skills/release/notes.md",
    ".claude/skills/release/references/nested/checklist.md",
  ];
  for (const path of rejected)
    assert.throws(
      () => run({ action: "read", path }),
      { code: "invalid_request" },
      path,
    );
});
