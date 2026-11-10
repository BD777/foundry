import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import {
  serverMcpURL,
  startServerMcpForwarder,
} from "../dist/platform/server-link/server-mcp-forwarder.js";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

test("the local MCP forwarder times out a response and identifies its phase", async (t) => {
  const target = createServer((request) => request.resume());
  const port = await listen(target);
  t.after(() => {
    target.closeAllConnections();
    target.close();
  });
  const targetURL = `http://127.0.0.1:${port}`;
  const logs = [];
  const stop = await startServerMcpForwarder(targetURL, {
    firstByteTimeoutMs: 40,
    log: (line) => logs.push(line),
  });
  t.after(stop);

  const response = await fetch(serverMcpURL(`${targetURL}/api/mcp`), {
    method: "POST",
    headers: { authorization: "Bearer never-log-this" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
  });
  assert.equal(response.status, 504);
  await response.arrayBuffer();
  assert.match(
    logs[0],
    /Foundry MCP forward failed during waiting for response/,
  );
  assert.match(logs[0], /after \d+ms/);
  assert.doesNotMatch(logs.join("\n"), /never-log-this|authorization/i);
});

test("the local MCP forwarder logs a proxy connection failure", async (t) => {
  const unavailable = createServer();
  const port = await listen(unavailable);
  await new Promise((resolve) => unavailable.close(resolve));
  const targetURL = `http://127.0.0.1:${port}`;
  const logs = [];
  const stop = await startServerMcpForwarder(targetURL, {
    firstByteTimeoutMs: 500,
    log: (line) => logs.push(line),
  });
  t.after(stop);

  const response = await fetch(serverMcpURL(`${targetURL}/api/mcp`), {
    method: "POST",
    body: "{}",
  });
  assert.equal(response.status, 502);
  await response.arrayBuffer();
  assert.match(logs[0], /Foundry MCP forward failed during proxy connection/);
});
