import assert from "node:assert/strict";
import test, { mock } from "node:test";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// listAgentModelsConfig merges in the device-local profile file, whose path
// the product pins to homedir()/.foundry (see profiles.ts
// deviceAgentProfilesPath) — it does not honor FOUNDRY_STATE_ROOT. Redirect
// only the os.homedir() built-in binding to a disposable directory BEFORE the
// dist modules are dynamically imported, so hardenPrivateFile never touches
// the real home. No HOME/CODEX_HOME environment variables are mutated; the
// standard node:test mock is restored after the file's tests end, and node
// runs each test file in its own process.
const isolatedHome = mkdtempSync(join(tmpdir(), "foundry-mab-home-"));
mock.method(os, "homedir", () => isolatedHome);
syncBuiltinESMExports();
test.after(() => {
  mock.restoreAll();
});

const { listAgentModelsConfig } = await import("../dist/models.js");

const workspacePath = "/tmp/foundry-model-access-boundary";

function endpointProfile(overrides) {
  return {
    apiKey: "write-only-secret",
    baseUrl: "https://relay.example.test/v1",
    connectionType: "openai_compatible",
    id: "relay",
    label: "Relay",
    runtime: "codex",
    ...overrides,
  };
}

/**
 * Catalog listing is the only sanctioned provider HTTP call: it reads `/models`
 * and nothing else. Anything resembling inference stays inside the native SDK
 * or CLI, so this pins the request shape the worker is allowed to make.
 */
test("an endpoint catalog is read from /models and nothing else", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ headers: init?.headers ?? {}, url: String(url) });
    return new Response(
      JSON.stringify({ data: [{ id: "gpt-6-astra", display_name: "Astra" }] }),
      { headers: { "content-type": "application/json" }, status: 200 },
    );
  };

  try {
    const models = await listAgentModelsConfig(
      endpointProfile(),
      workspacePath,
    );

    assert.deepEqual(models, [{ id: "gpt-6-astra", label: "Astra" }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://relay.example.test/v1/models");
    assert.equal(calls[0].headers.authorization, "Bearer write-only-secret");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an anthropic endpoint is asked with its own auth headers", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ headers: init?.headers ?? {}, url: String(url) });
    return new Response(JSON.stringify({ data: [{ id: "claude-opus-5" }] }), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  };

  try {
    const models = await listAgentModelsConfig(
      endpointProfile({
        baseUrl: "https://relay.example.test",
        connectionType: "anthropic_compatible",
        runtime: "claude",
      }),
      workspacePath,
    );

    assert.deepEqual(models, [{ id: "claude-opus-5" }]);
    assert.equal(calls[0].url, "https://relay.example.test/models");
    assert.equal(calls[0].headers["x-api-key"], "write-only-secret");
    assert.equal(calls[0].headers["anthropic-version"], "2023-06-01");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a refused catalog surfaces the endpoint's answer instead of guessing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("nope", { status: 403 });

  try {
    await assert.rejects(
      () => listAgentModelsConfig(endpointProfile(), workspacePath),
      /answered 403/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("official catalogs use native control APIs, never direct provider HTTP or saved model fallback", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    throw new Error("a local login has no endpoint to ask");
  };

  try {
    const models = await listAgentModelsConfig(
      {
        connectionType: "local_login",
        id: "claude_local",
        label: "Claude Local",
        model: "claude-opus-5",
        runtime: "claude",
      },
      workspacePath,
      {
        claude: async () => [{ id: "native-official-model" }],
        codex: async () => [],
      },
    );

    assert.deepEqual(models, [{ id: "native-official-model" }]);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
