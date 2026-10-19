import assert from "node:assert/strict";
import test from "node:test";
import {
  prepareExecution,
  executionReuseIdentity,
} from "../dist/session/preparation/index.js";

const profile = {
  id: "private",
  runtime: "codex",
  connectionType: "openai_compatible",
  model: "model",
  apiKey: "private-key-must-not-serialize",
  baseUrl: "https://endpoint.invalid",
};
const request = {
  purpose: "independent_judge",
  ownerId: "judge",
  workspacePath: "/candidate",
  profile,
  environment: () => ({ PRIVATE_TOKEN: "another-secret" }),
};
const window = async (_profile, model) => ({
  model,
  tokens: 700000,
  source: "setting",
});

test("judgment and workspace preparation share the selected model window without exposing private launch inputs", async () => {
  let resolved = 0;
  const prepared = await prepareExecution(
    {
      ...request,
      model: "other",
      managedSkills: {
        pluginDir: "/untrusted",
        skills: [{ name: "candidate", dir: "/candidate/skill" }],
      },
      environment: (selected) => {
        assert.equal(selected.model, "other");
        assert.equal(selected.contextWindow.tokens, 700000);
        return { PRIVATE_TOKEN: "another-secret" };
      },
    },
    {
      resolveWindow: async (...args) => {
        resolved++;
        return window(...args);
      },
      inventory: async () => {
        throw new Error("a judge must not inventory candidate skills");
      },
    },
  );
  assert.equal(resolved, 1);
  assert.deepEqual(prepared.manifest.skills, []);
  assert.deepEqual(prepared.readRoots, []);
  assert.equal(prepared.native.profile.apiKey, profile.apiKey);
  assert.equal(prepared.native.env.PRIVATE_TOKEN, "another-secret");
  assert.doesNotMatch(
    JSON.stringify(prepared),
    /private-key-must-not-serialize|another-secret|PRIVATE_TOKEN/,
  );
  await prepared.dispose();
});

test("reuse identity stays stable for the same connection but changes for its credential revision", async () => {
  const a = await prepareExecution(request, { resolveWindow: window });
  const b = await prepareExecution(
    { ...request, profile: { ...profile } },
    { resolveWindow: window },
  );
  const changed = await prepareExecution(
    { ...request, profile: { ...profile, apiKey: "new-private-key" } },
    { resolveWindow: window },
  );
  assert.equal(
    executionReuseIdentity(a.manifest),
    executionReuseIdentity(b.manifest),
  );
  assert.notEqual(
    executionReuseIdentity(a.manifest),
    executionReuseIdentity(changed.manifest),
  );
  await Promise.all([a.dispose(), b.dispose(), changed.dispose()]);
});

test("an input lease remains held for a background runtime after its turn ends, then closes once", async () => {
  let closed = 0;
  const prepared = await prepareExecution(request, {
    resolveWindow: window,
    cleanup: () => {
      closed++;
    },
  });
  const releaseRuntime = prepared.retain();
  await prepared.dispose();
  await prepared.dispose();
  assert.equal(closed, 0);
  await releaseRuntime();
  await releaseRuntime();
  assert.equal(closed, 1);
  assert.throws(() => prepared.retain(), /disposed/);
});

test("a preparation failure releases partial inputs and never returns an unverified inventory", async () => {
  let closed = 0;
  await assert.rejects(
    prepareExecution(
      {
        ...request,
        purpose: "workspace",
        managedSkills: { pluginDir: "/skills", skills: [] },
      },
      {
        resolveWindow: window,
        inventory: async () => {
          throw new Error("inventory unavailable");
        },
        cleanup: () => {
          closed++;
        },
      },
    ),
    /inventory unavailable/,
  );
  assert.equal(closed, 1);
});

test("cancellation during metadata resolution never constructs a launch environment", async () => {
  const canceled = new AbortController();
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  let launched = false,
    closed = 0;
  const result = prepareExecution(
    {
      ...request,
      signal: canceled.signal,
      environment: () => {
        launched = true;
        return {};
      },
    },
    {
      resolveWindow: async () => {
        await pending;
        return window(profile, "model");
      },
      cleanup: () => {
        closed++;
      },
    },
  );
  canceled.abort();
  release();
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(launched, false);
  assert.equal(closed, 1);
});

test("a manifest snapshots its mutable model input and private resources follow the final native owner", async () => {
  let cleanup = 0;
  const selectedWindow = { model: "model", tokens: 700000, source: "setting" };
  const prepared = await prepareExecution({
    ...request,
    profile: { ...profile, contextWindow: selectedWindow },
  });
  selectedWindow.tokens = 1000;
  assert.equal(prepared.manifest.contextWindow.tokens, 700000);
  assert.throws(() => {
    prepared.manifest.contextWindow.tokens = 100;
  }, TypeError);
  prepared.own(() => {
    cleanup++;
  });
  const release = prepared.retain();
  await prepared.dispose();
  assert.equal(cleanup, 0);
  assert.throws(() => prepared.own(() => {}), /no longer accepts/);
  await release();
  await release();
  assert.equal(cleanup, 1);
});

test("explicit execution owners isolate homes even without a Foundry session object", async (t) => {
  const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "prepared-owner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  for (const runtime of ["codex", "claude"]) {
    const key = runtime === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
    const selected = {
      ...profile,
      runtime,
      connectionType:
        runtime === "codex" ? "openai_compatible" : "anthropic_compatible",
      env: { [key]: join(root, runtime) },
    };
    const make = (ownerId) =>
      prepareExecution(
        {
          purpose: "workspace",
          ownerId,
          workspacePath: workspace,
          profile: selected,
        },
        { resolveWindow: window },
      );
    const first = await make("owner-A");
    const second = await make("owner-B");
    assert.notEqual(first.native.env[key], second.native.env[key]);
    assert.equal(first.manifest.paths.ownerId, "owner-A");
    assert.equal(second.manifest.paths.ownerId, "owner-B");
    await first.dispose();
    await second.dispose();
  }
});
