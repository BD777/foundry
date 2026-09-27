import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  sessionArtifactDirectories,
  sessionInputDirectory,
} from "../dist/session-artifacts.js";

test("each input keeps its own artifacts under its session", (t) => {
  const root = mkdtempSync(join(tmpdir(), "foundry-artifacts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const session = { id: "sess_a", prompt: "goal" };
  const first = sessionInputDirectory(root, {
    ...session,
    input: { id: "0190-a", prompt: "one" },
  });
  const second = sessionInputDirectory(root, {
    ...session,
    input: { id: "0190-b", prompt: "two" },
  });
  assert.equal(first, join(root, "sess_a", "inputs", "0190-a"));
  assert.notEqual(first, second, "a later input never shares a marker");
  assert.equal(sessionInputDirectory(root, session), join(root, "sess_a"));

  mkdirSync(second, { recursive: true });
  mkdirSync(first, { recursive: true });
  assert.deepEqual(sessionArtifactDirectories(root, "sess_a"), [
    first,
    second,
    join(root, "sess_a"),
  ]);
  assert.deepEqual(sessionArtifactDirectories(root, "sess_missing"), [
    join(root, "sess_missing"),
  ]);
});
