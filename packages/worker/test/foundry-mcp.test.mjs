import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Readable, Writable } from "node:stream";
import { once } from "node:events";
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

test("foundry mcp speaks MCP stdio and authenticates with the session token", async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    requests.push({
      method: req.method,
      path: url.pathname,
      authorization: req.headers.authorization,
    });
    if (url.pathname === "/api/agents") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify([
          {
            id: "agent_1",
            workspaceId: "ws_1",
            deviceId: "dev_1",
            provider: "claude",
            profileId: "prof_1",
          },
        ]),
      );
      return;
    }
    if (url.pathname === "/api/agent-sessions" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        requests[requests.length - 1].body = JSON.parse(body);
        res.setHeader("content-type", "application/json");
        res.statusCode = 201;
        res.end(
          JSON.stringify({
            id: "sess_child",
            status: "queued",
            parentSessionId: "sess_parent",
            workspaceId: "ws_1",
          }),
        );
      });
      return;
    }
    if (url.pathname === "/api/agent-sessions" && req.method === "GET") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify([
          {
            id: "sess_child",
            status: "running",
            parentSessionId: "sess_parent",
            workspaceId: "ws_1",
          },
          { id: "sess_other", status: "running", workspaceId: "ws_1" },
        ]),
      );
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;

  process.env.FOUNDRY_SERVER_URL = `http://127.0.0.1:${port}`;
  process.env.FOUNDRY_SESSION_TOKEN = "tok_parent";
  process.env.FOUNDRY_WORKSPACE_ID = "ws_1";
  process.env.FOUNDRY_SESSION_ID = "sess_parent";

  const input = jsonLines([
    { jsonrpc: "2.0", id: 1, method: "initialize" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_sessions", arguments: { parentOnly: true } },
    },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "create_session",
        arguments: { prompt: "do the thing", profileId: "prof_1" },
      },
    },
  ]);
  const output = new CollectWriter();
  await runMcpServer(input, output);

  const byId = Object.fromEntries(
    output.messages().map((message) => [message.id, message]),
  );
  assert.equal(byId[1].result.serverInfo.name, "foundry");
  assert.ok(
    byId[2].result.tools.some((tool) => tool.name === "create_session"),
  );

  const childList = JSON.parse(byId[3].result.content[0].text);
  assert.deepEqual(
    childList.map((session) => session.id),
    ["sess_child"],
  );

  const created = JSON.parse(byId[4].result.content[0].text);
  assert.equal(created.id, "sess_child");

  // Every upstream call carried the session bearer token.
  assert.ok(
    requests.every((request) => request.authorization === "Bearer tok_parent"),
  );

  // The create body routed through the resolved agent.
  const createCall = requests.find(
    (request) =>
      request.method === "POST" && request.path === "/api/agent-sessions",
  );
  assert.equal(createCall.body.agentId, "agent_1");
  assert.equal(createCall.body.workspaceId, "ws_1");

  server.close();
});
