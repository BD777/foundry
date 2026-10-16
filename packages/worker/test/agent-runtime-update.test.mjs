import assert from "node:assert/strict";
import test from "node:test";
import { updateAgentRuntime } from "../dist/agent-runtime/update-controller.js";
import {
  acquireRuntime,
  tryMaintainRuntime,
} from "../dist/agent-runtime/maintenance.js";
import {
  stablePackageVersion,
  isStableVersion,
} from "../dist/agent-runtime/release-source.js";

function fixture() {
  let state;
  let updated = 0;
  let released = 0;
  const deps = {
    now: () => 1000000,
    read: () => state,
    write: (_id, s) => (state = { ...s }),
    maintain: async () => () => released++,
    busy: () => false,
  };
  const adapter = {
    id: "test-agent",
    inspect: async () => ({ current: "1.0.0", target: "1.1.0", needed: true }),
    update: async () => {
      updated++;
    },
  };
  return {
    deps,
    adapter,
    state: () => state,
    updated: () => updated,
    released: () => released,
  };
}
test("new agent adapters use the same stable update controller", async () => {
  const f = fixture();
  await updateAgentRuntime(f.adapter, f.deps);
  assert.equal(f.state().state, "current");
  assert.equal(f.updated(), 1);
  assert.equal(f.released(), 1);
  await updateAgentRuntime(f.adapter, f.deps);
  assert.equal(f.updated(), 1, "fresh metadata is reused");
});
test("active work postpones activation and leaves release metadata visible", async () => {
  const f = fixture();
  f.deps.maintain = async () => undefined;
  await updateAgentRuntime(f.adapter, f.deps);
  assert.equal(f.state().state, "waiting_idle");
  assert.equal(f.state().target, "1.1.0");
  assert.equal(f.updated(), 0);
});
test("failure preserves current version and releases the maintenance gate", async () => {
  const f = fixture();
  f.adapter.update = async () => {
    throw Error("installation failed");
  };
  await updateAgentRuntime(f.adapter, f.deps);
  assert.equal(f.state().state, "failed");
  assert.equal(f.state().current, "1.0.0");
  assert.equal(f.released(), 1);
});
test("app-owned and pinned executables are not overwritten", async () => {
  const f = fixture();
  f.adapter.inspect = async () => ({
    current: "1.0.0",
    target: "1.1.0",
    needed: true,
    external: "App owns this executable",
  });
  await updateAgentRuntime(f.adapter, f.deps);
  assert.equal(f.state().state, "external");
  assert.equal(f.updated(), 0);
});
test("launch leases exclude update and new launches queue during activation", async () => {
  const read = await acquireRuntime("test-agent");
  assert.equal(await tryMaintainRuntime("test-agent"), undefined);
  read();
  const write = await tryMaintainRuntime("test-agent");
  assert.ok(write);
  let launched = false;
  const pending = acquireRuntime("test-agent").then((release) => {
    launched = true;
    return release;
  });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(launched, false);
  write();
  (await pending)();
  const other = await tryMaintainRuntime("another-agent");
  assert.ok(other);
  other();
});
test("metadata channels never activate alpha/beta/rc releases", async () => {
  for (const v of ["0.162.0-alpha.17.2", "2.0.0-beta", "3.0.0-rc.1"])
    assert.equal(isStableVersion(v), false);
  await assert.rejects(
    stablePackageVersion(
      "@openai/codex",
      "latest",
      async () => new Response(JSON.stringify({ version: "0.162.0-alpha.1" })),
    ),
    /stable/,
  );
  assert.equal(
    await stablePackageVersion(
      "@anthropic-ai/claude-code",
      "stable",
      async (url) => {
        assert.match(url, /\/stable$/);
        return new Response(JSON.stringify({ version: "2.1.292" }));
      },
    ),
    "2.1.292",
  );
});

test("account generations change on identity/source changes, not token refresh", async (t) => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { nativeAccountFingerprint } =
    await import("../dist/native-account.js");
  const root = mkdtempSync(join(tmpdir(), "foundry-account-generation-"));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = root;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const save = (account, access) =>
    writeFileSync(
      join(root, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { account_id: account, access_token: access },
      }),
    );
  save("account-a", "old-secret");
  const first = nativeAccountFingerprint("codex");
  save("account-a", "renewed-secret");
  assert.equal(nativeAccountFingerprint("codex"), first);
  save("account-b", "renewed-secret");
  assert.notEqual(nativeAccountFingerprint("codex"), first);
  assert.doesNotMatch(first, /account|secret/);
});

test("known Claude processes do not block Codex updates and unknown owners stay conservative", async () => {
  const { processRuntime } = await import("../dist/agent-runtime/updates.js");
  assert.equal(processRuntime(["claude"]), "claude");
  assert.equal(
    processRuntime(["/home/u/.local/share/claude/versions/2.1.292"]),
    "claude",
  );
  assert.equal(
    processRuntime(["/tools/node_modules/.bin/codex", "app-server"]),
    "codex",
  );
  assert.equal(processRuntime(["/custom/opaque-agent"]), undefined);
});
