import test from "node:test";
import assert from "node:assert/strict";
import { codexQuotaWindows, claudeQuotaWindows } from "../dist/native-quota.js";

test("Codex multi-bucket limits supersede legacy duplicates and preserve periods/unknown", () => {
  const legacy = { primary: { usedPercent: 5, windowDurationMins: 300 } };
  const rows = codexQuotaWindows({
    rateLimits: legacy,
    rateLimitsByLimitId: {
      codex: legacy,
      other: {
        limitName: "Model bucket",
        primary: {
          usedPercent: 0,
          windowDurationMins: 15,
          resetsAt: 1900000000,
        },
        secondary: { usedPercent: null, windowDurationMins: 10080 },
      },
    },
  });
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.id),
    ["codex:primary", "other:primary", "other:secondary"],
  );
  assert.equal(rows[1].usedPercent, 0);
  assert.equal(rows[1].label, "Model bucket");
  assert.equal(rows[2].usedPercent, undefined);
  assert.equal(codexQuotaWindows({ rateLimits: legacy })[0].windowMinutes, 300);
  for (const invalid of [NaN, Infinity, -1, 101, "42", null])
    assert.equal(
      codexQuotaWindows({
        rateLimits: { primary: { usedPercent: invalid } },
      })[0].usedPercent,
      undefined,
    );
});
test("Claude reads plan percentages and model windows; no session cost or disabled extra usage", () => {
  const input = {
    rate_limits_available: true,
    session: { total_cost_usd: 999 },
    rate_limits: {
      five_hour: { utilization: 12.5, resets_at: "2030-01-01T00:00:00Z" },
      seven_day: { utilization: 0, resets_at: null },
      seven_day_opus: { utilization: null },
      model_scoped: [{ display_name: "Model A", utilization: 42 }],
      extra_usage: { is_enabled: false, utilization: 33 },
    },
    behaviors: { private: "discard" },
  };
  const rows = claudeQuotaWindows(input);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].usedPercent, 12.5);
  assert.equal(rows[0].resetsAt, 1893456000);
  assert.equal(rows[1].usedPercent, 0);
  assert.equal(rows[2].usedPercent, undefined);
  assert.equal(rows[3].label, "Model A");
  assert.doesNotMatch(JSON.stringify(rows), /999|private|33/);
  assert.deepEqual(
    claudeQuotaWindows({ ...input, rate_limits_available: false }),
    [],
  );
  assert.deepEqual(
    claudeQuotaWindows({ rate_limits_available: true, rate_limits: null }),
    [],
  );
  input.rate_limits.extra_usage.is_enabled = true;
  assert.equal(claudeQuotaWindows(input).at(-1).id, "extra_usage");
});

test("selected-account cache deduplicates native reads and rejects an account switch in flight", async () => {
  const { createSelectedAccountInspector } =
    await import("../dist/native-quota-cache.js");
  let generation = "a",
    calls = 0,
    resolve;
  const read = createSelectedAccountInspector(
    () => generation,
    async () => {
      calls++;
      return new Promise((r) => (resolve = r));
    },
  );
  const a = read("codex", "a"),
    b = read("codex", "a", true);
  assert.equal(a, b);
  assert.equal(calls, 1);
  resolve({ runtimeGeneration: "a", usage: [] });
  await a;
  assert.equal(await read("codex", "a"), await a);
  assert.equal(calls, 1);
  const forced = read("codex", "a", true);
  generation = "b";
  resolve({ runtimeGeneration: "a" });
  await assert.rejects(forced, /changed/);
  await assert.rejects(read("codex", "a"), /changed/);
  assert.equal(calls, 2);
  const current = read("codex", "b");
  resolve({ runtimeGeneration: "b" });
  await current;
  assert.equal(calls, 3);
});

test("quota authentication does not renew expired credentials or honor forced renewal", async (t) => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { authenticateIsolatedCodex } =
    await import("../dist/agent-runtime/codex-auth.js");
  const dir = mkdtempSync(join(tmpdir(), "quota-auth-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const token = (exp) =>
    `e30.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`;
  const save = (exp) =>
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({
        tokens: { account_id: "synthetic", access_token: token(exp) },
      }),
    );
  const calls = [];
  const client = {
    request: async (method) => {
      calls.push(method);
    },
  };
  save(1);
  await assert.rejects(
    authenticateIsolatedCodex(
      client,
      { FOUNDRY_CODEX_AUTH_SOURCE: dir },
      "/never-spawn",
      false,
    ),
    /cannot renew/,
  );
  assert.deepEqual(calls, []);
  save(Math.floor(Date.now() / 1000) + 3600);
  await authenticateIsolatedCodex(
    client,
    { FOUNDRY_CODEX_AUTH_SOURCE: dir },
    "/never-spawn",
    false,
  );
  assert.deepEqual(calls, ["account/login/start"]);
  await assert.rejects(
    client.onRequest("account/chatgptAuthTokens/refresh", {}),
    /cannot renew/,
  );
});
