import test from "node:test";
import assert from "node:assert/strict";
import { modelsFromResponse } from "../dist/models.js";
import {
  claudeContextWindowEnvironment,
  resolveSessionContextWindow,
  withSessionContextWindow,
} from "../dist/context-window.js";
import { profileRuntimeEnvironment } from "../dist/profiles.js";
import { codexProfileConfig } from "../dist/runner/codex-options.js";
import { ClaudeContextTracker } from "../dist/context-usage.js";

function serverProfile(overrides = {}) {
  return {
    id: "prof_relay",
    label: "super-relay",
    runtime: "claude",
    origin: "server",
    connectionType: "anthropic_compatible",
    baseUrl: "https://relay.example.test",
    model: "auto_model/alwaysday1_max",
    ...overrides,
  };
}

const catalog = async () => [
  { id: "auto_model/alwaysday1_max", contextWindow: 1_000_000 },
  { id: "ark/60b-0614c", contextWindow: 200_000 },
  { id: "claude-opus-4-8" },
];

test("catalog rows keep the window their endpoint reports", () => {
  const models = modelsFromResponse({
    object: "list",
    data: [
      // super-relay's shape
      {
        id: "ark/60b-0614c",
        object: "model",
        display_name: "60b",
        context_length: 200000,
      },
      { id: "or/model", top_provider: { context_length: 131072 } },
      { id: "anthropic", max_input_tokens: 1000000 },
      { id: "vllm", max_model_len: "32768" },
      { id: "gateway", owned_by: "x", created: 0 },
      { id: "nonsense", context_length: -1 },
    ],
  });
  assert.deepEqual(models, [
    { id: "ark/60b-0614c", label: "60b", contextWindow: 200_000 },
    { id: "or/model", contextWindow: 131_072 },
    { id: "anthropic", contextWindow: 1_000_000 },
    { id: "vllm", contextWindow: 32_768 },
    { id: "gateway" },
    { id: "nonsense" },
  ]);
});

test("a run's window follows setting, endpoint catalog, official model, default", async () => {
  const profile = serverProfile({
    contextWindows: { "ark/60b-0614c": 150_000 },
  });
  const resolve = (model) =>
    resolveSessionContextWindow(profile, model, catalog);
  assert.deepEqual(await resolve("ark/60b-0614c"), {
    model: "ark/60b-0614c",
    tokens: 150_000,
    source: "setting",
  });
  assert.deepEqual(await resolve("auto_model/alwaysday1_max"), {
    model: "auto_model/alwaysday1_max",
    tokens: 1_000_000,
    source: "endpoint",
  });
  assert.deepEqual(await resolve("claude-opus-4-8"), {
    model: "claude-opus-4-8",
    tokens: 1_000_000,
    source: "official",
  });
  assert.deepEqual(await resolve("seed/unknown"), {
    model: "seed/unknown",
    tokens: 1_000_000,
    source: "default",
  });
  // An endpoint whose catalog cannot be read falls through.
  const failing = async () => {
    throw new Error("401");
  };
  assert.deepEqual(
    await resolveSessionContextWindow(profile, "gpt-5.5", failing),
    { model: "gpt-5.5", tokens: 272_000, source: "official" },
  );
});

test("logins and device profiles keep the CLI's own window", async () => {
  for (const profile of [
    serverProfile({ origin: undefined }),
    serverProfile({ connectionType: "local_login", baseUrl: undefined }),
  ]) {
    const session = { id: "s", model: "auto_model/alwaysday1_max" };
    const resolved = await withSessionContextWindow(profile, session, catalog);
    assert.equal(resolved.contextWindow, undefined);
  }
});

test("Claude Code gets the window for a model it does not know", async () => {
  const profile = await withSessionContextWindow(
    serverProfile(),
    { id: "s" },
    catalog,
  );
  const env = profileRuntimeEnvironment(profile);
  assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "1000000");
  assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, undefined);
  // A session on another model than the one resolved gets nothing stale.
  const other = profileRuntimeEnvironment(profile, {
    id: "s",
    model: "ark/60b-0614c",
  });
  assert.equal(other.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
});

test("a smaller window on a model Claude Code knows caps its auto-compact", () => {
  assert.deepEqual(
    claudeContextWindowEnvironment({
      model: "claude-opus-4-8",
      tokens: 400_000,
      source: "setting",
    }),
    {
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "400000",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "400000",
    },
  );
  assert.deepEqual(
    claudeContextWindowEnvironment({
      model: "claude-sonnet-4-6[1m]",
      tokens: 500_000,
      source: "setting",
    }),
    {
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "500000",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "500000",
    },
  );
  // Not larger than what the CLI already runs with: nothing to cap.
  assert.deepEqual(
    claudeContextWindowEnvironment({
      model: "claude-sonnet-4-6",
      tokens: 1_000_000,
      source: "setting",
    }),
    { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1000000" },
  );
});

test("Codex gets model_context_window for a compatible endpoint", async () => {
  const profile = await withSessionContextWindow(
    serverProfile({
      runtime: "codex",
      connectionType: "openai_compatible",
      baseUrl: "https://gw.example.test/v1",
      model: "flux/gpt-6-astra",
    }),
    { id: "s" },
    async () => [],
  );
  const config = codexProfileConfig(profile, { CODEX_API_KEY: "k" });
  assert.equal(
    config.model_providers[config.model_provider].base_url,
    "https://gw.example.test/v1",
  );
  assert.equal(config.model_context_window, 872_000);
});

test("context reports say which window Foundry set and why", () => {
  const tracker = new ClaudeContextTracker({
    resumed: false,
    configured: { tokens: 1_000_000, source: "endpoint" },
  });
  tracker.observe({
    type: "stream_event",
    event: { type: "message_start", message: { model: "m" } },
  });
  const report = tracker.observe({
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: { trigger: "auto", pre_tokens: 5000, post_tokens: 900 },
  });
  assert.deepEqual(report?.configuredWindow, {
    tokens: 1_000_000,
    source: "endpoint",
  });
});

test("an opt-in Claude model resolved to 1M runs as <model>[1m]; others keep their name", async () => {
  const { claudeRunModel } = await import("../dist/context-window.js");
  const run = (model, tokens, source = "endpoint") =>
    claudeRunModel(
      serverProfile({ contextWindow: { model, tokens, source } }),
      model,
    );
  assert.equal(run("claude-sonnet-4-6", 1_000_000), "claude-sonnet-4-6[1m]");
  assert.equal(
    run("anthropic/claude-sonnet-4.5", 1_000_000, "setting"),
    "anthropic/claude-sonnet-4.5[1m]",
  );
  assert.equal(run("claude-opus-4-6", 1_048_576), "claude-opus-4-6[1m]");
  // Below 1M, already 1M natively, without a 1M opt-in, or already opted in.
  assert.equal(
    run("claude-sonnet-4-6", 200_000, "official"),
    "claude-sonnet-4-6",
  );
  assert.equal(
    run("claude-sonnet-4-6", 500_000, "setting"),
    "claude-sonnet-4-6",
  );
  assert.equal(
    run("claude-opus-4-8", 1_000_000, "official"),
    "claude-opus-4-8",
  );
  assert.equal(
    run("claude-haiku-4-5", 1_000_000, "setting"),
    "claude-haiku-4-5",
  );
  assert.equal(
    run("auto_model/alwaysday1_max", 1_000_000),
    "auto_model/alwaysday1_max",
  );
  assert.equal(
    run("claude-sonnet-4-6[1m]", 1_000_000),
    "claude-sonnet-4-6[1m]",
  );
  // A window resolved for another model never renames this one.
  assert.equal(
    claudeRunModel(
      serverProfile({
        contextWindow: { model: "x", tokens: 1_000_000, source: "setting" },
      }),
      "claude-sonnet-4-6",
    ),
    "claude-sonnet-4-6",
  );
});

test("Claude Code is started on [1m] while Foundry keeps the plain name", async () => {
  const profile = await withSessionContextWindow(
    serverProfile({
      model: "claude-sonnet-4-6",
      contextWindows: { "claude-sonnet-4-6": 1_000_000 },
    }),
    { id: "s" },
    catalog,
  );
  const env = profileRuntimeEnvironment(profile);
  assert.equal(env.ANTHROPIC_MODEL, "claude-sonnet-4-6[1m]");
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, "claude-sonnet-4-6[1m]");
  assert.equal(env.FOUNDRY_AGENT_MODEL, "claude-sonnet-4-6");
  assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, undefined);

  // The CLI names the model with its suffix in results; reports do not.
  const tracker = new ClaudeContextTracker({
    resumed: false,
    configured: { tokens: 1_000_000, source: "setting" },
  });
  const stream = (event) => ({
    type: "stream_event",
    parent_tool_use_id: null,
    event,
  });
  for (const message of [
    stream({
      type: "message_start",
      message: {
        id: "m1",
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }),
    stream({
      type: "message_delta",
      usage: { input_tokens: 1000, output_tokens: 2 },
    }),
    stream({ type: "message_stop" }),
  ])
    tracker.observe(message);
  const report = tracker.observe({
    type: "result",
    subtype: "success",
    total_cost_usd: 0,
    usage: { input_tokens: 1000, output_tokens: 2 },
    modelUsage: { "claude-sonnet-4-6[1m]": { contextWindow: 1_000_000 } },
  });
  assert.equal(report?.contextWindow, 1_000_000);
  assert.equal(report?.model, "claude-sonnet-4-6");
});

test("official Codex opts Astra into its supported window, including resumed turns", async () => {
  const profile = serverProfile({
    runtime: "codex",
    connectionType: "local_login",
    baseUrl: undefined,
    model: "gpt-5.5",
  });
  const resolved = await withSessionContextWindow(
    profile,
    { id: "s", model: "gpt-6-astra", nativeSessionId: "existing" },
    async () => {
      throw new Error("must not query endpoint");
    },
  );
  assert.deepEqual(resolved.contextWindow, {
    model: "gpt-6-astra",
    tokens: 872000,
    source: "official",
  });
  assert.deepEqual(codexProfileConfig(resolved, {}), {
    model_provider: "openai",
    model_context_window: 872000,
  });
  assert.equal(872000 * 0.95, 828400);
  assert.equal(
    (await withSessionContextWindow(profile, { id: "s", model: "unknown" }))
      .contextWindow,
    undefined,
  );
});

test("official Codex respects a saved per-model window without changing other models", async () => {
  const profile = {
    runtime: "codex",
    connectionType: "local_login",
    contextWindows: { "gpt-6-astra": 400_000 },
  };
  assert.deepEqual(await resolveSessionContextWindow(profile, "gpt-6-astra"), {
    model: "gpt-6-astra",
    tokens: 400_000,
    source: "setting",
  });
  assert.deepEqual(await resolveSessionContextWindow(profile, "gpt-5.6-sol"), {
    model: "gpt-5.6-sol",
    tokens: 872_000,
    source: "official",
  });
});
