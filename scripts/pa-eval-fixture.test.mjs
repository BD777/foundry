import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  applyHistory,
  cutoffGroups,
  populateProject,
  projectFolder,
} from "./pa-eval-fixture.mjs";

const c = (id, snapshot) => ({ id, snapshot });

test("cutoff groups: a small week joins the earlier group, never a later one", () => {
  const groups = cutoffGroups([
    c("a", "2026-06-01"),
    c("b", "2026-06-08"),
    c("c", "2026-06-15"),
    c("d", "2026-06-15"),
    c("e", "2026-06-15"),
    c("f", "2026-09-07"),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.cutoff, g.cases.map((x) => x.id).join("")]),
    [
      ["2026-06-01", "ab"],
      ["2026-06-15", "cde"],
      ["2026-09-07", "f"],
    ],
  );
  for (const g of groups)
    for (const x of g.cases) assert.ok(g.cutoff <= x.snapshot);
});

test("cutoff groups refuse a case without a week", () => {
  assert.throws(() => cutoffGroups([c("a", "unknown")]), /no week/);
});

test("a project's folder holds its files and its intro, inside the run folder", () => {
  const stack = mkdtempSync(resolve(tmpdir(), "pa-eval-fixture-"));
  try {
    const folder = populateProject(stack, {
      computer: "macbook",
      name: "notes",
      files: ["AGENTS.md", "docs/", "plan.md", "../escape"],
      intro: "Notes and plans.",
    });
    assert.equal(folder, projectFolder(stack, "macbook", "notes"));
    assert.ok(folder.startsWith(resolve(stack, "pa-eval") + "/"));
    assert.equal(
      readFileSync(resolve(folder, "AGENTS.md"), "utf8"),
      "Notes and plans.\n",
    );
    assert.ok(existsSync(resolve(folder, "docs")));
    assert.ok(!existsSync(resolve(folder, "..", "escape")));
  } finally {
    rmSync(stack, { recursive: true, force: true });
  }
});

test("history before the cutoff replaces the earlier cutoff's and drops the changed digests", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE chats (id TEXT PRIMARY KEY, title TEXT, payload_json TEXT, updated_at TEXT, workspace_id TEXT, provider TEXT, native_session_id TEXT, activity_at TEXT);
           CREATE TABLE workspace_digests (user_id TEXT, workspace_id TEXT);
           INSERT INTO workspace_digests VALUES ('u', 'ws_a'), ('u', 'ws_b');`);
  const index = {
    projects: [
      {
        workspaceId: "ws_a",
        history: [
          { at: "2026-07-01T00:00:00Z", title: "later", request: "later ask" },
          { at: "2026-05-01T00:00:00Z", title: "early", request: "early ask" },
        ],
      },
      { workspaceId: "ws_b", history: [] },
    ],
  };
  const titles = () =>
    db
      .prepare("SELECT title FROM chats ORDER BY updated_at")
      .all()
      .map((r) => r.title);
  assert.deepEqual(applyHistory(db, index, "u", "2026-06-01"), ["ws_a"]);
  assert.deepEqual(titles(), ["early"]);
  assert.deepEqual(applyHistory(db, index, "u", "2026-06-02"), []);
  assert.deepEqual(applyHistory(db, index, "u", "2026-08-01"), ["ws_a"]);
  assert.deepEqual(titles(), ["early", "later"]);
  assert.deepEqual(
    db
      .prepare("SELECT workspace_id FROM workspace_digests")
      .all()
      .map((r) => r.workspace_id),
    ["ws_b"],
  );
});
