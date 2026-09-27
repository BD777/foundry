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

test("a session runs each of its inputs once and reports itself while active", () => {
  const registry = new SessionExecutionRegistry();

  assert.equal(registry.claim("session_1", "input_1"), true);
  assert.equal(registry.claim("session_1", "input_1"), false);
  assert.deepEqual(registry.activeSessionIds(), ["session_1"]);
  registry.complete("session_1", "input_1");
  assert.equal(registry.claim("session_1", "input_1"), false);
  assert.equal(registry.claim("session_1", "input_2"), true);
  assert.deepEqual(registry.activeSessionIds(), ["session_1"]);
});

test("handled covers inputs running or recently finished in this process", () => {
  const registry = new SessionExecutionRegistry();
  assert.equal(registry.handled("sess", "in_1"), false);
  registry.claim("sess", "in_1");
  assert.equal(registry.handled("sess", "in_1"), true);
  registry.complete("sess", "in_1");
  assert.equal(registry.handled("sess", "in_1"), true);
  assert.equal(registry.handled("sess", "in_2"), false);
});
