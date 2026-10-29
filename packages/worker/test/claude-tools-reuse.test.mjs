// DEV-084: a reused Claude process keeps its Foundry tools connection when
// only the per-dispatch token differs and the token it holds still works.
import assert from "node:assert/strict";
import test from "node:test";

const { claudeToolsNeedHandOver } =
  await import("../dist/runner/foundry-tools.js");

const servers = (token, url = "https://server/api/mcp") => ({
  foundry: {
    type: "http",
    url,
    headers: { Authorization: `Bearer ${token}` },
    timeout: 660000,
  },
});
const minute = 60_000;
const hour = 60 * minute;

test("a reuse of the same session keeps the held token, also after the session went idle", () => {
  const now = 10 * 24 * hour;
  const runtime = {
    foundrySessionId: "sess_a",
    mcpServers: servers("held"),
    mcpServersAt: now - 15 * minute,
  };
  // The default warm-runtime TTL is 15 min after the last turn.
  assert.equal(
    claudeToolsNeedHandOver(runtime, "sess_a", servers("fresh"), now),
    false,
  );
  // A runtime kept warm for hours (activeRuntimeTtlMs up to 24 h).
  runtime.mcpServersAt = now - 19 * hour;
  assert.equal(
    claudeToolsNeedHandOver(runtime, "sess_a", servers("fresh"), now),
    false,
  );
});

test("an old token, another session or another endpoint is handed over", () => {
  const now = 10 * 24 * hour;
  const base = {
    foundrySessionId: "sess_a",
    mcpServers: servers("held"),
    mcpServersAt: now - minute,
  };
  // Past 20 h the server may have retired the held token (a day unused
  // while the session was idle): reconnect with the fresh one.
  assert.equal(
    claudeToolsNeedHandOver(
      { ...base, mcpServersAt: now - 20 * hour },
      "sess_a",
      servers("fresh"),
      now,
    ),
    true,
  );
  assert.equal(
    claudeToolsNeedHandOver(base, "sess_b", servers("fresh"), now),
    true,
    "a token of another session acts as that session",
  );
  assert.equal(
    claudeToolsNeedHandOver(
      base,
      "sess_a",
      servers("fresh", "https://other/api/mcp"),
      now,
    ),
    true,
  );
  assert.equal(
    claudeToolsNeedHandOver(
      { ...base, mcpServersAt: undefined },
      "sess_a",
      servers("fresh"),
      now,
    ),
    true,
    "unknown age",
  );
  assert.equal(
    claudeToolsNeedHandOver(
      { ...base, mcpServers: undefined },
      "sess_a",
      servers("fresh"),
      now,
    ),
    true,
  );
  // No tools at all now (a token-less dispatch): handed over, so they go.
  assert.equal(claudeToolsNeedHandOver(base, "sess_a", {}, now), true);
});
