import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { requestExtensionUpstream } from "../dist/connectors/extension-network.js";

test("an extension network request preserves the path, headers and body", async (t) => {
  let observed;
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    observed = {
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
      body: Buffer.concat(chunks).toString(),
    };
    response.writeHead(201, {
      "content-type": "application/json",
      "x-upstream": "fixture",
    });
    response.end('{"ok":true}');
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    upstream.closeAllConnections();
    upstream.close();
  });
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const answer = await requestExtensionUpstream({
    method: "POST",
    url: `${base}/openlark/agent/v1/search?q=one`,
    headers: { Authorization: "Bearer fixture-secret" },
    body: Buffer.from('{"query":"one"}').toString("base64"),
    timeoutSeconds: 5,
  });
  assert.deepEqual(observed, {
    method: "POST",
    path: "/openlark/agent/v1/search?q=one",
    authorization: "Bearer fixture-secret",
    body: '{"query":"one"}',
  });
  assert.equal(answer.status, 201);
  assert.deepEqual(answer.headers["x-upstream"], ["fixture"]);
  assert.equal(Buffer.from(answer.body, "base64").toString(), '{"ok":true}');
});

test("an extension network error does not echo request headers", async () => {
  await assert.rejects(
    requestExtensionUpstream({
      method: "GET",
      url: "http://127.0.0.1:1/openlark",
      headers: { Authorization: "Bearer must-not-leak" },
      timeoutSeconds: 1,
    }),
    (error) => !String(error).includes("must-not-leak"),
  );
});
