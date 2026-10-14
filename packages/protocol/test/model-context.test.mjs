import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultContextWindow,
  officialContextWindow,
  parseContextWindow,
  resolveContextWindow,
} from "../dist/index.js";

test("the person's setting wins, then the endpoint, then the official model, then 1M", () => {
  const model = "claude-opus-4-8";
  assert.deepEqual(
    resolveContextWindow(model, { setting: 300_000, endpoint: 500_000 }),
    {
      tokens: 300_000,
      source: "setting",
    },
  );
  assert.deepEqual(resolveContextWindow(model, { endpoint: 500_000 }), {
    tokens: 500_000,
    source: "endpoint",
  });
  assert.deepEqual(resolveContextWindow(model), {
    tokens: 1_000_000,
    source: "official",
  });
  assert.deepEqual(resolveContextWindow("auto_model/alwaysday1_max"), {
    tokens: defaultContextWindow,
    source: "default",
  });
  // Out-of-range values are not windows and fall through.
  assert.deepEqual(
    resolveContextWindow("gpt-5.5", { setting: 0, endpoint: 12 }),
    {
      tokens: 272_000,
      source: "official",
    },
  );
});

test("official windows are found under the names relays give models", () => {
  const cases = {
    "claude-sonnet-4-6": 200_000,
    "anthropic/claude-sonnet-4.5": 200_000,
    "us.anthropic.claude-opus-4-1-20250805-v1:0": 200_000,
    "claude-opus-4-20250514": 200_000,
    "claude-opus-4-6@20260101": 200_000,
    "claude-opus-4-8[1m]": 1_000_000,
    "CLAUDE-HAIKU-5-5": 1_000_000,
    "flux/gpt-6-astra": 872_000,
    "mira/gpt-5.6-sol": 872_000,
    "gpt-5.4": 1_000_000,
    "gpt-5.5-2026-04-01": 272_000,
  };
  for (const [model, tokens] of Object.entries(cases))
    assert.equal(officialContextWindow(model), tokens, model);
  // Unsourced families and unknown versions fall through to the default.
  for (const model of [
    "claude-3-7-sonnet",
    "claude-opus-4-9",
    "gpt-5.5-pro",
    "flux/GPT-6.1-Sol",
    "flux/gpt-5.6",
    "aime/kimi-k3",
  ])
    assert.equal(officialContextWindow(model), undefined, model);
});

test("typed windows accept plain counts and k/m suffixes", () => {
  assert.equal(parseContextWindow("200000"), 200_000);
  assert.equal(parseContextWindow("200k"), 200_000);
  assert.equal(parseContextWindow(" 1M "), 1_000_000);
  assert.equal(parseContextWindow("1.5m"), 1_500_000);
  assert.equal(parseContextWindow("1,048,576"), 1_048_576);
  for (const bad of ["", "abc", "0", "12", "100m", "-5k"])
    assert.equal(parseContextWindow(bad), undefined, bad);
});

test("Claude models whose 1M window is an opt-in are named from Claude Code's table", async () => {
  const { claudeOneMillionOptIn, withoutOneMillionSuffix } =
    await import("../dist/index.js");
  for (const model of [
    "claude-sonnet-4-6",
    "claude-sonnet-4-5-20250929",
    "us.anthropic.claude-sonnet-4-20250514-v1:0",
    "claude-opus-4-6",
  ])
    assert.equal(claudeOneMillionOptIn(model), true, model);
  for (const model of [
    "claude-opus-4-8",
    "claude-sonnet-5",
    "claude-haiku-4-5",
    "claude-opus-4-5",
    "gpt-5.4",
    "seed/unknown",
  ])
    assert.equal(claudeOneMillionOptIn(model), false, model);
  assert.equal(
    withoutOneMillionSuffix("claude-sonnet-4-6[1m]"),
    "claude-sonnet-4-6",
  );
});
