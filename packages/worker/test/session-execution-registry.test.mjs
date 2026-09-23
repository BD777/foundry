import assert from "node:assert/strict";
import test from "node:test";
import { SessionExecutionRegistry } from "../dist/session-state.js";

test("rejects duplicate active and recently completed sessions", () => {
  const registry = new SessionExecutionRegistry(2);

  assert.equal(registry.claim("session_1"), true);
  assert.equal(registry.claim("session_1"), false);
  registry.complete("session_1");
  assert.equal(registry.claim("session_1"), false);
});

test("bounds completed-session deduplication without evicting active work", () => {
  const registry = new SessionExecutionRegistry(2);

  assert.equal(registry.claim("active"), true);
  assert.equal(registry.claim("session_1"), true);
  registry.complete("session_1");
  assert.equal(registry.claim("session_2"), true);
  registry.complete("session_2");
  assert.equal(registry.claim("session_3"), true);
  registry.complete("session_3");

  assert.equal(registry.claim("active"), false);
  assert.equal(registry.claim("session_1"), true);
  assert.equal(registry.claim("session_2"), false);
  assert.equal(registry.claim("session_3"), false);
});

test("exposes only process-owned active sessions for reconnect claims", () => {
  const registry = new SessionExecutionRegistry();
  registry.claim("session_b");
  registry.claim("session_a");
  registry.complete("session_b");

  assert.deepEqual(registry.activeSessionIds(), ["session_a"]);
});
