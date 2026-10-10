import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(packageDir, "dist", "foundry-cli.js");

/** A Foundry server that records tool calls and answers each with reply. */
async function fakeTools(t, reply) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const message = JSON.parse(body);
      calls.push({
        path: req.url,
        authorization: req.headers.authorization,
        name: message.params?.name,
        arguments: message.params?.arguments,
      });
      const [text, isError] = reply(message.params?.name);
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text }], isError },
        }),
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  return { calls, url: `http://127.0.0.1:${server.address().port}` };
}

async function foundry(args, env = {}) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    env: { ...process.env, ...env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const [code] = await once(child, "exit");
  return { code, stdout, stderr };
}

test("session get and events read a session by link through the Foundry tools", async (t) => {
  const { calls, url } = await fakeTools(t, (name) => [
    name === "get_session" ? '{"id":"sess_9","status":"failed"}' : "events",
    false,
  ]);
  const env = {
    FOUNDRY_SERVER_URL: url,
    FOUNDRY_SESSION_TOKEN: "token-1",
    FOUNDRY_WORKSPACE_ID: "",
  };
  const link = "https://foundry.example/chats/sess_9?workspace=ws_a";

  const got = await foundry(["session", "get", link], env);
  assert.equal(got.code, 0, got.stderr);
  assert.equal(got.stdout.trim(), '{"id":"sess_9","status":"failed"}');

  const events = await foundry(
    [
      "session",
      "events",
      link,
      "--errors",
      "--level",
      "info",
      "--label",
      "Session failed,Waiting for background tasks",
      "--query",
      "idle timeout",
      "--tail",
      "20",
      "--context",
      "2",
      "--after",
      "2026-10-09T20:00:00Z",
      "--max-bytes",
      "5000",
    ],
    env,
  );
  assert.equal(events.code, 0, events.stderr);
  assert.equal(events.stdout.trim(), "events");
  assert.deepEqual(
    calls.map((call) => [call.path, call.authorization, call.name]),
    [
      ["/api/mcp", "Bearer token-1", "get_session"],
      ["/api/mcp", "Bearer token-1", "read_context"],
    ],
  );
  assert.deepEqual(calls[0].arguments, { sessionId: link });
  assert.deepEqual(calls[1].arguments, {
    sessionId: link,
    scope: "events",
    levels: ["info", "error", "warning"],
    labels: ["Session failed", "Waiting for background tasks"],
    query: "idle timeout",
    tail: 20,
    context: 2,
    after: "2026-10-09T20:00:00Z",
    maxBytes: 5000,
  });
  const page = await foundry(
    ["session", "events", "sess_9", "--limit", "10", "--before", "evt_1"],
    env,
  );
  assert.equal(page.code, 0, page.stderr);
  assert.deepEqual(calls[2].arguments, {
    sessionId: "sess_9",
    scope: "events",
    limit: 10,
    before: "evt_1",
  });
});

test("session events refuses bad flags and reports tool errors", async (t) => {
  const { calls, url } = await fakeTools(t, () => [
    "no session or chat sess_x that you can read",
    true,
  ]);
  const env = { FOUNDRY_SERVER_URL: url, FOUNDRY_SESSION_TOKEN: "token-1" };
  const badTail = await foundry(
    ["session", "events", "sess_x", "--tail", "many"],
    env,
  );
  assert.equal(badTail.code, 1);
  assert.match(badTail.stderr, /--tail needs a positive whole number/);
  const noId = await foundry(["session", "events", "--errors"], env);
  assert.equal(noId.code, 1);
  assert.match(noId.stderr, /session id or Foundry chat link is required/);
  assert.equal(calls.length, 0);
  const missing = await foundry(["session", "get", "sess_x"], env);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /no session or chat sess_x that you can read/);
});

test("workspace and device lists come from the Foundry tools", async (t) => {
  const { calls, url } = await fakeTools(t, (name) => [name, false]);
  const env = { FOUNDRY_SERVER_URL: url, FOUNDRY_SESSION_TOKEN: "token-1" };
  assert.equal(
    (await foundry(["workspace", "list"], env)).stdout.trim(),
    "list_workspaces",
  );
  assert.equal(
    (await foundry(["device", "list"], env)).stdout.trim(),
    "list_resources",
  );
  assert.deepEqual(
    calls.map((call) => call.arguments),
    [{}, {}],
  );
});

test("the foundry skill ships with the CLI, same as the server's built-in, and installs", async () => {
  const listed = await foundry(["skill", "list"]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.deepEqual(listed.stdout.trim().split("\n"), [
    "foundry",
    "foundry-orchestrator",
  ]);
  const printed = await foundry(["skill", "foundry"]);
  const builtin = readFileSync(
    resolve(
      packageDir,
      "../../apps/server/internal/builtinskills/foundry/SKILL.md",
    ),
    "utf8",
  );
  assert.equal(printed.stdout, builtin);
  assert.match(
    (await foundry(["skill"])).stdout,
    /^---\nname: foundry-orchestrator\n/,
  );
  const root = mkdtempSync(join(tmpdir(), "foundry-skill-"));
  try {
    const installed = await foundry([
      "skill",
      "install",
      "foundry",
      "--dir",
      root,
    ]);
    assert.equal(installed.code, 0, installed.stderr);
    assert.equal(
      readFileSync(join(root, "foundry", "SKILL.md"), "utf8"),
      builtin,
    );
    const unknown = await foundry(["skill", "install", "nope", "--dir", root]);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /no bundled skill nope/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
