import test from "node:test";
import assert from "node:assert/strict";
import { sessionEnvironment } from "../dist/profiles.js";

const ambientKeys = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLAUDE_API_KEY",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
];

function withAmbientCredentials(run) {
  const previous = {};
  for (const key of ambientKeys) {
    previous[key] = process.env[key];
    process.env[key] = `ambient-${key}`;
  }
  try {
    return run();
  } finally {
    for (const key of ambientKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test("a keyless server codex profile never inherits the daemon's credentials", () => {
  withAmbientCredentials(() => {
    const env = sessionEnvironment("/workspace", {
      id: "gw",
      runtime: "codex",
      label: "LLM Gateway",
      origin: "server",
      connectionType: "openai_compatible",
      baseUrl: "http://gateway.internal/v1",
    });
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.CODEX_API_KEY, undefined);
    // The endpoint and its non-credential configuration still go through.
    assert.equal(env.OPENAI_BASE_URL, "http://gateway.internal/v1");
    assert.equal(env.CODEX_BASE_URL, "http://gateway.internal/v1");
    // Unrelated inherited environment (PATH) is untouched.
    assert.equal(env.PATH, process.env.PATH);
  });
});

test("a keyless server claude profile never inherits the daemon's credentials", () => {
  withAmbientCredentials(() => {
    const env = sessionEnvironment("/workspace", {
      id: "gw",
      runtime: "claude",
      label: "Claude GW",
      origin: "server",
      connectionType: "anthropic_compatible",
      baseUrl: "http://gateway.internal",
    });
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.CLAUDE_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_BASE_URL, "http://gateway.internal");
  });
});

test("a server profile with a dispatched key uses exactly that key", () => {
  withAmbientCredentials(() => {
    const env = sessionEnvironment("/workspace", {
      id: "gw",
      runtime: "codex",
      label: "LLM Gateway",
      origin: "server",
      connectionType: "openai_compatible",
      baseUrl: "http://gateway.internal/v1",
      apiKey: "dispatched-key",
    });
    assert.equal(env.OPENAI_API_KEY, "dispatched-key");
    assert.equal(env.CODEX_API_KEY, undefined);
  });
});

test("official local logins keep their existing native-login isolation", () => {
  withAmbientCredentials(() => {
    const env = sessionEnvironment("/workspace", {
      id: "codex_local",
      runtime: "codex",
      label: "Codex Local",
      connectionType: "local_login",
    });
    // Unchanged behaviour: the native login path pins the vendor endpoint and
    // blanks inherited key vars so the CLI uses the machine's own login.
    assert.equal(env.OPENAI_API_KEY, "");
    assert.equal(env.CODEX_API_KEY, "");
    assert.equal(env.CODEX_BASE_URL, "https://api.openai.com/v1");
  });
});

test("a device-owned compatible profile keeps inheriting the device environment", () => {
  withAmbientCredentials(() => {
    const env = sessionEnvironment("/workspace", {
      id: "local_gw",
      runtime: "codex",
      label: "Local GW",
      origin: "device",
      connectionType: "openai_compatible",
      baseUrl: "http://gateway.internal/v1",
    });
    assert.equal(env.OPENAI_API_KEY, "ambient-OPENAI_API_KEY");
  });
});
