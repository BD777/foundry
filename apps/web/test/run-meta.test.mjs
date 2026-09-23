import assert from "node:assert/strict";
import test from "node:test";
import { runPhase } from "../src/lib/run-meta.ts";

test("running phase does not invent editing or validation from provider identity", () => {
  for (const runtime of ["claude", "codex", "mock"]) {
    assert.equal(runPhase({ runtime, status: "running" }), "Executing");
    assert.equal(runPhase({ runtime, status: "completed" }), "Complete");
  }
});
