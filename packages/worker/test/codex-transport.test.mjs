import assert from "node:assert/strict";
import test from "node:test";

const { CodexTransportLearner, codexTransportPlan, codexWebsocketFallback } =
  await import("../dist/runner/codex-transport.js");
const { codexProfileConfig } = await import("../dist/runner/codex-options.js");

const profile = {
  id: "prof_gw",
  runtime: "codex",
  origin: "server",
  connectionType: "openai_compatible",
  baseUrl: "http://127.0.0.1:9/v1",
};

const learned = (transport) => ({
  transport,
  learnedAt: "2026-10-14T00:00:00Z",
});

test("the override wins, auto follows what was learned, unknown is a trial", () => {
  assert.deepEqual(codexTransportPlan({}), {
    websockets: false,
    learn: "none",
  });
  assert.deepEqual(
    codexTransportPlan({
      codexTransport: "https",
      codexTransportLearned: learned("websocket"),
    }),
    { websockets: false, learn: "none" },
  );
  assert.deepEqual(
    codexTransportPlan({
      codexTransport: "websocket",
      codexTransportLearned: learned("https"),
    }),
    { websockets: true, learn: "none" },
  );
  assert.deepEqual(codexTransportPlan({ codexTransport: "auto" }), {
    websockets: true,
    learn: "outcome",
  });
  assert.deepEqual(
    codexTransportPlan({
      codexTransport: "auto",
      codexTransportLearned: learned("https"),
    }),
    { websockets: false, learn: "none" },
  );
  assert.deepEqual(
    codexTransportPlan({
      codexTransport: "auto",
      codexTransportLearned: learned("websocket"),
    }),
    { websockets: true, learn: "fallback" },
  );
});

test("Codex is told whether to try the WebSocket, with a bounded handshake", () => {
  const provider = (config) => config.model_providers.foundry_prof_gw;
  const trial = provider(
    codexProfileConfig({ ...profile, codexTransport: "auto" }, {}),
  );
  assert.equal(trial.supports_websockets, true);
  assert.equal(trial.websocket_connect_timeout_ms, 5000);
  const https = provider(
    codexProfileConfig(
      {
        ...profile,
        codexTransport: "auto",
        codexTransportLearned: learned("https"),
      },
      {},
    ),
  );
  assert.equal(https.supports_websockets, false);
  assert.equal("websocket_connect_timeout_ms" in https, false);
});

// Recorded from Codex 0.153.4 against an endpoint answering the upgrade 404.
const fallbackEvent = {
  type: "item.completed",
  item: {
    id: "item_1",
    type: "error",
    message:
      "Falling back from WebSockets to HTTPS transport. unexpected status 404 Not Found: Unknown error, url: ws://127.0.0.1:18731/v1/responses",
  },
};
const reconnectEvent = {
  type: "error",
  message:
    "Reconnecting... 2/5 (unexpected status 404 Not Found: Unknown error, url: ws://127.0.0.1:18731/v1/responses)",
};

test("the fallback notice is recognized and its reason kept", () => {
  assert.equal(
    codexWebsocketFallback(fallbackEvent),
    "unexpected status 404 Not Found: Unknown error, url: ws://127.0.0.1:18731/v1/responses",
  );
  assert.equal(codexWebsocketFallback(reconnectEvent), undefined);
  assert.equal(
    codexWebsocketFallback({
      type: "item.completed",
      item: { type: "error", message: "Model metadata for `x` not found." },
    }),
    undefined,
  );
});

function recorder() {
  const events = [];
  return {
    events,
    emit: async (label, detail, level, metadata) =>
      void events.push({ label, detail, level, metadata }),
  };
}

test("a trial reports HTTPS on the fallback, once", async () => {
  const { events, emit } = recorder();
  const learner = new CodexTransportLearner(
    { websockets: true, learn: "outcome" },
    profile,
    emit,
  );
  await learner.observe(reconnectEvent, false);
  await learner.observe(fallbackEvent, false);
  await learner.observe({ type: "turn.completed" }, true);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].metadata.codexTransport, {
    profileId: "prof_gw",
    baseUrl: "http://127.0.0.1:9/v1",
    transport: "https",
    detail:
      "unexpected status 404 Not Found: Unknown error, url: ws://127.0.0.1:18731/v1/responses",
  });
});

test("a trial turn that completes without a fallback reports WebSocket", async () => {
  const { events, emit } = recorder();
  const learner = new CodexTransportLearner(
    { websockets: true, learn: "outcome" },
    profile,
    emit,
  );
  await learner.observe({ type: "turn.started" }, false);
  await learner.observe({ type: "turn.completed" }, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].metadata.codexTransport.transport, "websocket");
});

test("a learned WebSocket reports only a fallback; fixed choices report nothing", async () => {
  const { events, emit } = recorder();
  const known = new CodexTransportLearner(
    { websockets: true, learn: "fallback" },
    profile,
    emit,
  );
  await known.observe({ type: "turn.completed" }, true);
  assert.equal(events.length, 0);
  await known.observe(fallbackEvent, false);
  assert.equal(events[0].metadata.codexTransport.transport, "https");
  const fixed = new CodexTransportLearner(
    { websockets: true, learn: "none" },
    profile,
    emit,
  );
  await fixed.observe(fallbackEvent, false);
  await fixed.observe({ type: "turn.completed" }, true);
  assert.equal(events.length, 1);
});

test("Codex reconnecting is a notice, a real error still fails the session", async () => {
  const { sdkProcessEvent } = await import("../dist/sdk-messages.js");
  const retry = sdkProcessEvent(reconnectEvent);
  assert.equal(retry.label, "Notice");
  assert.equal(retry.level, "warning");
  const failed = sdkProcessEvent({ type: "error", message: "stream closed" });
  assert.equal(failed.label, "Session failed");
  assert.equal(failed.level, "error");
});
