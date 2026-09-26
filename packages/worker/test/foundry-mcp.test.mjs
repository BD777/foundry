import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Readable, Writable } from "node:stream";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMcpServer } from "../dist/foundry-mcp.js";

function jsonLines(lines) {
  return Readable.from(lines.map((line) => JSON.stringify(line) + "\n"));
}

class CollectWriter extends Writable {
  constructor() {
    super();
    this.chunks = [];
  }
  _write(chunk, _encoding, callback) {
    this.chunks.push(chunk.toString());
    callback();
  }
  messages() {
    return this.chunks.join("").trim().split("\n").map(JSON.parse);
  }
}

async function fakeServer(t, reply) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const request = {
        method: req.method,
        path: req.url,
        authorization: req.headers.authorization,
        device: req.headers["x-foundry-device-credential"],
        body: JSON.parse(body),
      };
      requests.push(request);
      reply(request, res);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  return { requests, url: `http://127.0.0.1:${server.address().port}` };
}

function withEnv(t, values) {
  const saved = {};
  for (const [name, value] of Object.entries(values)) {
    saved[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

test("foundry mcp forwards stdio JSON-RPC to the server's tools with the session token", async (t) => {
  const { requests, url } = await fakeServer(t, (request, res) => {
    const { id, method } = request.body;
    if (id === undefined) {
      res.statusCode = 202;
      res.end();
      return;
    }
    if (method === "tools/call" && request.body.params.name === "denied") {
      res.statusCode = 403;
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32003, message: "forbidden" },
        }),
      );
      return;
    }
    if (method === "tools/call" && request.body.params.name === "broken") {
      res.statusCode = 502;
      res.end("bad gateway");
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { echoed: method } }));
  });
  withEnv(t, {
    FOUNDRY_SERVER_URL: url,
    FOUNDRY_SESSION_TOKEN: "tok_parent",
    FOUNDRY_WORKSPACE_ID: "ws_1",
  });

  const output = new CollectWriter();
  await runMcpServer(
    jsonLines([
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "list_sessions", arguments: { parentOnly: true } },
      },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "denied" },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "broken" },
      },
    ]),
    output,
  );

  const byId = Object.fromEntries(
    output.messages().map((message) => [message.id, message]),
  );
  assert.equal(output.messages().length, 4, "a notification gets no reply");
  assert.equal(byId[1].result.echoed, "initialize");
  assert.equal(byId[2].result.echoed, "tools/call");
  assert.equal(
    byId[3].error.message,
    "forbidden",
    "server errors pass through",
  );
  assert.match(byId[4].error.message, /502: bad gateway/);

  assert.ok(requests.every((request) => request.path === "/api/mcp"));
  assert.ok(
    requests.every((request) => request.authorization === "Bearer tok_parent"),
  );
  assert.deepEqual(requests[2].body.params.arguments, {
    parentOnly: true,
    workspaceId: "ws_1",
  });
});

test("foundry mcp without a session token authenticates as the paired device", async (t) => {
  const { requests, url } = await fakeServer(t, (request, res) => {
    res.end(
      JSON.stringify({ jsonrpc: "2.0", id: request.body.id, result: {} }),
    );
  });
  const state = mkdtempSync(join(tmpdir(), "foundry-mcp-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  writeFileSync(
    join(state, "daemon-config.json"),
    JSON.stringify({ serverURL: url, deviceCredential: "dev_secret" }),
  );
  withEnv(t, {
    FOUNDRY_SERVER_URL: undefined,
    FOUNDRY_SESSION_TOKEN: undefined,
    FOUNDRY_WORKSPACE_ID: undefined,
    FOUNDRY_STATE_ROOT: state,
  });

  const output = new CollectWriter();
  await runMcpServer(
    jsonLines([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]),
    output,
  );
  assert.equal(output.messages()[0].id, 1);
  assert.equal(requests[0].authorization, undefined);
  assert.equal(requests[0].device, "dev_secret");
});
