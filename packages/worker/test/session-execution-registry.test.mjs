import assert from "node:assert/strict";
import test from "node:test";
import { SessionExecutionRegistry } from "../dist/session/session-state.js";

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

// DEV-144: a session waiting on a long background task sends no events. The
// heartbeat claims it for as long as this process runs it, so the server
// does not fail it as stale; once it ends, the heartbeat stops claiming it.
test("the heartbeat claims the sessions this process runs, however silent", async () => {
  const { daemonHeartbeat } =
    await import("../dist/daemon/control-connection.js");
  const { ReliableSessionTransport } =
    await import("../dist/transport/transport.js");
  const sessionExecutions = new SessionExecutionRegistry();
  const sessionTransport = new ReliableSessionTransport();
  sessionExecutions.claim("waiting_on_build", "input_1");

  const first = daemonHeartbeat({ sessionExecutions, sessionTransport });
  assert.deepEqual(first.activeSessionIds, ["waiting_on_build"]);
  assert.equal(first.outbox.queued, 0);
  assert.deepEqual(
    daemonHeartbeat({ sessionExecutions, sessionTransport }).activeSessionIds,
    ["waiting_on_build"],
    "a later heartbeat still claims it without any session event between",
  );

  sessionExecutions.complete("waiting_on_build", "input_1");
  assert.deepEqual(
    daemonHeartbeat({ sessionExecutions, sessionTransport }).activeSessionIds,
    [],
  );
});
