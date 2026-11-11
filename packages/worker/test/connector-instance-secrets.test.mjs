import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import {
  serverMcpURL,
  startServerMcpForwarder,
} from "../dist/platform/server-link/server-mcp-forwarder.js";
import { registerSessionAmbientEnv } from "../dist/session/session-ambient.js";
import { prepareConnectorInstanceSecretRequest } from "../dist/session/connector-instance-secrets.js";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

function tempDir(t) {
  const directory = mkdtempSync(join(tmpdir(), "foundry-connector-secret-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function connectorRequest(secretFiles) {
  return {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: {
      name: "connector_instances",
      arguments: {
        action: "create",
        kind: "acme-api",
        fields: { baseUrl: "https://connector.example" },
        secretFiles,
      },
    },
  };
}

function edgeAccessRequest(secretFiles) {
  return {
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: {
      name: "edge_access",
      arguments: {
        action: "create",
        label: "OpenLark edge",
        provider: "cloudflare_access",
        match: { host: "openlark.example.com", pathPrefix: "/agent" },
        secretFiles,
      },
    },
  };
}

function registerAmbient(session, serverURL, workspacePath) {
  const release = registerSessionAmbientEnv(session.id, {
    serverURL,
    sessionToken: session.token,
    workspaceID: "ws_test",
    workspacePath,
    connectorInstanceFiles: true,
  });
  session.release = release;
  return release;
}

async function mcpResponse(url, token, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return response.json();
}

test("connector_instances resolves secretFiles in the worker before forwarding", async (t) => {
  const directory = tempDir(t);
  const secret = "synthetic-openlark-token-123456";
  writeFileSync(
    join(directory, ".env"),
    `# local only\nOTHER=value\nOPEN_LARK_AGENT_TOKEN=${secret}\n`,
    { mode: 0o600 },
  );
  const requests = [];
  const target = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          result: { content: [{ type: "text", text: "created" }] },
        }),
      );
    });
  });
  const port = await listen(target);
  t.after(() => {
    target.closeAllConnections();
    target.close();
  });
  const targetURL = `http://127.0.0.1:${port}`;
  const logs = [];
  const stop = await startServerMcpForwarder(targetURL, {
    prepareRequest: prepareConnectorInstanceSecretRequest,
    log: (line) => logs.push(line),
  });
  t.after(stop);
  const session = {
    id: "sess_connector_secret",
    token: "session-secret-token",
  };
  t.after(registerAmbient(session, targetURL, directory));

  const response = await mcpResponse(
    serverMcpURL(`${targetURL}/api/mcp`),
    session.token,
    connectorRequest({
      readToken: { path: ".env", key: "OPEN_LARK_AGENT_TOKEN" },
    }),
  );
  assert.equal(response.result.content[0].text, "created");
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].headers["x-foundry-mcp-secret-proxy"],
    "connector-instances-v1",
  );
  const forwarded = JSON.parse(requests[0].body);
  assert.deepEqual(forwarded.params.arguments.secretValues, {
    readToken: secret,
  });
  assert.equal(forwarded.params.arguments.secretFiles, undefined);
  assert.equal(forwarded.params.arguments.fields.readToken, undefined);
  assert.equal(requests[0].body.includes("secretFiles"), false);
  assert.equal(logs.join("\n").includes(secret), false);
});

test("edge_access resolves only its two secret files in the worker", async (t) => {
  const directory = tempDir(t);
  const clientID = "edge-client-id-123456";
  const clientSecret = "edge-client-secret-abcdef";
  writeFileSync(
    join(directory, ".env"),
    `CF_ACCESS_CLIENT_ID=${clientID}\nCF_ACCESS_CLIENT_SECRET=${clientSecret}\n`,
    { mode: 0o600 },
  );
  const requests = [];
  const target = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 8,
          result: { content: [{ type: "text", text: "created" }] },
        }),
      );
    });
  });
  const port = await listen(target);
  t.after(() => {
    target.closeAllConnections();
    target.close();
  });
  const targetURL = `http://127.0.0.1:${port}`;
  const logs = [];
  const stop = await startServerMcpForwarder(targetURL, {
    prepareRequest: prepareConnectorInstanceSecretRequest,
    log: (line) => logs.push(line),
  });
  t.after(stop);
  const session = {
    id: "sess_edge_access_secret",
    token: "session-edge-access-token",
  };
  t.after(registerAmbient(session, targetURL, directory));
  const url = serverMcpURL(`${targetURL}/api/mcp`);

  const response = await mcpResponse(
    url,
    session.token,
    edgeAccessRequest({
      clientId: { path: ".env", key: "CF_ACCESS_CLIENT_ID" },
      clientSecret: { path: ".env", key: "CF_ACCESS_CLIENT_SECRET" },
    }),
  );
  assert.equal(response.result.content[0].text, "created");
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].headers["x-foundry-mcp-secret-proxy"],
    "connector-instances-v1",
  );
  const forwarded = JSON.parse(requests[0].body);
  assert.deepEqual(forwarded.params.arguments.secretValues, {
    clientId: clientID,
    clientSecret,
  });
  assert.equal(forwarded.params.arguments.secretFiles, undefined);
  assert.equal(requests[0].body.includes("secretFiles"), false);
  assert.equal(logs.join("\n").includes(clientID), false);
  assert.equal(logs.join("\n").includes(clientSecret), false);

  const unsupported = await mcpResponse(
    url,
    session.token,
    edgeAccessRequest({ readToken: { path: ".env" } }),
  );
  assert.equal(unsupported.result.isError, true);
  assert.match(
    unsupported.result.content[0].text,
    /accepts only clientId and clientSecret/,
  );
  assert.equal(requests.length, 1);
});

test("connector_instances reports missing files and variables without content", async (t) => {
  const directory = tempDir(t);
  const unrelatedSecret = "must-not-appear-in-errors-987654";
  writeFileSync(join(directory, ".env"), `OTHER=${unrelatedSecret}\n`, {
    mode: 0o600,
  });
  let requests = 0;
  const target = createServer((request, response) => {
    requests++;
    request.resume();
    response.writeHead(500);
    response.end();
  });
  const port = await listen(target);
  t.after(() => {
    target.closeAllConnections();
    target.close();
  });
  const targetURL = `http://127.0.0.1:${port}`;
  const logs = [];
  const stop = await startServerMcpForwarder(targetURL, {
    prepareRequest: prepareConnectorInstanceSecretRequest,
    log: (line) => logs.push(line),
  });
  t.after(stop);
  const session = {
    id: "sess_connector_missing",
    token: "session-missing-token",
  };
  t.after(registerAmbient(session, targetURL, directory));
  const url = serverMcpURL(`${targetURL}/api/mcp`);

  const missingVariable = await mcpResponse(
    url,
    session.token,
    connectorRequest({
      readToken: { path: ".env", key: "OPEN_LARK_AGENT_TOKEN" },
    }),
  );
  assert.equal(missingVariable.result.isError, true);
  assert.match(
    missingVariable.result.content[0].text,
    /variable .* does not exist/,
  );
  assert.equal(
    missingVariable.result.content[0].text.includes(unrelatedSecret),
    false,
  );

  const missingFile = await mcpResponse(
    url,
    session.token,
    connectorRequest({
      readToken: { path: "missing.env", key: "OPEN_LARK_AGENT_TOKEN" },
    }),
  );
  assert.equal(missingFile.result.isError, true);
  assert.match(missingFile.result.content[0].text, /does not exist/);
  assert.equal(
    missingFile.result.content[0].text.includes(unrelatedSecret),
    false,
  );
  assert.equal(requests, 0);
  assert.equal(logs.join("\n").includes(unrelatedSecret), false);
});

test("a forwarded secret never appears in transport error logs", async (t) => {
  const directory = tempDir(t);
  const secret = "transport-log-secret-abcdef123456";
  writeFileSync(join(directory, "token.txt"), `${secret}\n`, { mode: 0o600 });
  const unavailable = createServer();
  const port = await listen(unavailable);
  await new Promise((resolve) => unavailable.close(resolve));
  const targetURL = `http://127.0.0.1:${port}`;
  const logs = [];
  const stop = await startServerMcpForwarder(targetURL, {
    prepareRequest: prepareConnectorInstanceSecretRequest,
    firstByteTimeoutMs: 500,
    log: (line) => logs.push(line),
  });
  t.after(stop);
  const session = {
    id: "sess_connector_transport",
    token: "session-transport-token",
  };
  t.after(registerAmbient(session, targetURL, directory));

  const response = await fetch(serverMcpURL(`${targetURL}/api/mcp`), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(
      connectorRequest({ readToken: { path: "token.txt" } }),
    ),
  });
  assert.equal(response.status, 502);
  await response.arrayBuffer();
  assert.ok(logs.length > 0);
  assert.equal(logs.join("\n").includes(secret), false);
});
