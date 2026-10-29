import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sessionBrowserToolEnvironment } from "../dist/resource-pool.js";
import {
  redactSecrets,
  redactTranscriptText,
} from "../dist/secret-redaction.js";
import { sessionEvent } from "../dist/session-helpers.js";

// Synthetic values only.
const password = "Synth77-proxy-Pw-0000aaaa";
const proxy = `http://synth-user:${encodeURIComponent(password)}@127.0.0.1:9`;

const chromium = (path) => ({
  id: "browser:playwright-chromium",
  kind: "browser",
  name: "Chromium (Playwright)",
  available: true,
  attributes: { path },
});

test("playwright-cli starts the session's launcher for the device's Playwright Chromium", () => {
  const resources = [
    {
      id: "browser:google-chrome",
      kind: "browser",
      name: "Google Chrome",
      available: true,
      attributes: { path: "/opt/google/chrome/chrome" },
    },
    chromium("/cache/ms-playwright/chromium-1246/chrome-linux64/chrome"),
  ];
  const env = sessionBrowserToolEnvironment({}, "sess_dev077", resources);
  const launcher = env.PLAYWRIGHT_MCP_EXECUTABLE_PATH;
  assert.match(launcher, /\/bin\/playwright-chromium$/);
  const script = readFileSync(launcher, "utf8");
  assert.match(script, /Foundry lease: Chromium \(Playwright\)/);
  assert.match(script, /chromium-1246\/chrome-linux64\/chrome/);

  // Without a scratch directory the session gets the browser itself.
  assert.equal(
    sessionBrowserToolEnvironment({}, undefined, resources)
      .PLAYWRIGHT_MCP_EXECUTABLE_PATH,
    "/cache/ms-playwright/chromium-1246/chrome-linux64/chrome",
  );
  // A browser the session already names wins; everyday Chrome alone is
  // what playwright-cli finds by itself.
  assert.deepEqual(
    sessionBrowserToolEnvironment(
      { PLAYWRIGHT_MCP_EXECUTABLE_PATH: "/mine" },
      undefined,
      resources,
    ),
    {},
  );
  assert.deepEqual(
    sessionBrowserToolEnvironment({}, undefined, [resources[0]]),
    {},
  );
});

test("agent-browser gets the proxy credential as its own variables, never in the URL", () => {
  const env = sessionBrowserToolEnvironment(
    { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, NO_PROXY: "example.test" },
    undefined,
    [],
  );
  assert.deepEqual(env, {
    AGENT_BROWSER_PROXY: "http://127.0.0.1:9",
    AGENT_BROWSER_PROXY_USERNAME: "synth-user",
    AGENT_BROWSER_PROXY_PASSWORD: password,
  });
  // No proxy, a proxy without a credential, or the session's own split
  // credential: nothing to change.
  assert.deepEqual(sessionBrowserToolEnvironment({}, undefined, []), {});
  assert.deepEqual(
    sessionBrowserToolEnvironment(
      { HTTPS_PROXY: "http://127.0.0.1:9" },
      undefined,
      [],
    ),
    {},
  );
  assert.deepEqual(
    sessionBrowserToolEnvironment(
      { HTTPS_PROXY: proxy, AGENT_BROWSER_PROXY_PASSWORD: "set" },
      undefined,
      [],
    ),
    {},
  );
});

test("the proxy password never reaches Foundry's transcripts, events or logs", () => {
  sessionBrowserToolEnvironment({ HTTPS_PROXY: proxy }, undefined, []);
  // What agent-browser's stream sends every client, and the password as an
  // agent might print it in no recognizable shape.
  const launch = JSON.stringify({
    action: "launch",
    params: {
      proxy: {
        server: "http://127.0.0.1:9",
        username: "synth-user",
        password,
      },
    },
    type: "command",
  });
  const printed = `proxy login synth-user ${password} accepted`;
  for (const text of [launch, printed, proxy]) {
    assert.ok(!redactTranscriptText(text).includes(password));
    assert.ok(!redactSecrets(text).includes(password));
    const event = sessionEvent(
      "sess_dev077",
      "Tool output",
      text,
      "info",
      "e",
      undefined,
      {
        id: "m",
        role: "tool",
        text,
        title: text,
      },
    );
    assert.ok(!JSON.stringify(event).includes(password));
  }
  assert.equal(redactSecrets("nothing secret"), "nothing secret");
});

test("session processes get the browser tool environment", async () => {
  const { registerSessionAmbientEnv, sessionEnvironment } =
    await import("../dist/session-ambient.js");
  // Only the synthetic proxy: a session running this test may carry its own
  // proxy and agent-browser variables, which take precedence.
  const keys = [
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
    "AGENT_BROWSER_PROXY",
    "AGENT_BROWSER_PROXY_USERNAME",
    "AGENT_BROWSER_PROXY_PASSWORD",
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.HTTPS_PROXY = proxy;
  const unregister = registerSessionAmbientEnv("sess_dev077_env", {
    serverURL: "http://s",
    sessionToken: "t",
    workspaceID: "w",
  });
  try {
    const env = sessionEnvironment(
      "/w",
      { id: "p", runtime: "codex", connectionType: "local_login" },
      { id: "sess_dev077_env", input: { id: "i", prompt: "x" } },
    );
    assert.equal(env.AGENT_BROWSER_PROXY, "http://127.0.0.1:9");
    assert.equal(env.AGENT_BROWSER_PROXY_PASSWORD, password);
  } finally {
    unregister();
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
