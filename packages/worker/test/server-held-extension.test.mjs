import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { prepareServerHeldExtensionSession } from "../dist/connectors/server-held-extension.js";
import { redactTranscriptText } from "../dist/platform/secret-redaction.js";

const localHandle = "fdyext_user_fixture_local";
const renewedHandle = "fdyext_user_fixture_renewed";
const material = {
  accountId: "acme-account",
  provider: "acme-api",
  label: "Acme API",
  tool: "acme",
  profileName: "unused",
  clientId: "",
  expiresAt: new Date(Date.now() - 1000).toISOString(),
  gateway: {
    path: "/api/connectors/extensions/acme-api/gateway",
    appHandle: "",
    userHandle: localHandle,
  },
  sessionEnvironment: {
    ACME_BASE: "{gatewayBase}",
    ACME_TOKEN: "{standIn}",
    ACME_ACCOUNT: "42",
  },
};
const session = { id: "extension-session", source: "chat", role: "chat" };

async function fixture(t) {
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({
      path: req.url,
      method: req.method,
      authorization: req.headers.authorization,
      device: req.headers["x-foundry-device-credential"],
    });
    assert.equal(req.headers.authorization, `Bearer ${renewedHandle}`);
    assert.equal(req.headers["x-foundry-device-credential"], "fixture-device");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  let renewals = 0;
  const prepared = await prepareServerHeldExtensionSession(
    session,
    [material],
    {
      serverURL: `http://127.0.0.1:${server.address().port}`,
      credential: () => "fixture-device",
      renew: async (sessionId, provider, accountId) => {
        assert.equal(sessionId, "extension-session");
        assert.equal(provider, "acme-api");
        assert.equal(accountId, "acme-account");
        renewals++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          path: material.gateway.path,
          appHandle: "",
          userHandle: renewedHandle,
          expiresAt: new Date(Date.now() + 1800000).toISOString(),
        };
      },
    },
  );
  t.after(() => prepared.release());
  return { calls, prepared, renewals: () => renewals };
}

test("a server-held extension gets only loopback templates and a stand-in", async (t) => {
  const f = await fixture(t);
  assert.match(f.prepared.environment.ACME_BASE, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(f.prepared.environment.ACME_TOKEN, localHandle);
  assert.equal(f.prepared.environment.ACME_ACCOUNT, "42");
  assert.equal("REAL_SECRET" in f.prepared.environment, false);
  const url = `${f.prepared.environment.ACME_BASE}/api/read`;
  const headers = {
    authorization: `Bearer ${localHandle}`,
    "X-Foundry-Device-Credential": "forged",
  };
  const replies = await Promise.all([
    fetch(url, { headers }),
    fetch(url, { headers }),
  ]);
  for (const reply of replies) assert.equal(reply.status, 200);
  assert.equal(f.renewals(), 1);
  assert.deepEqual(
    f.calls.map((call) => [
      call.method,
      call.path,
      call.authorization,
      call.device,
    ]),
    [
      [
        "GET",
        "/api/connectors/extensions/acme-api/gateway/api/read",
        `Bearer ${renewedHandle}`,
        "fixture-device",
      ],
      [
        "GET",
        "/api/connectors/extensions/acme-api/gateway/api/read",
        `Bearer ${renewedHandle}`,
        "fixture-device",
      ],
    ],
  );
  assert.equal(
    redactTranscriptText(`token ${localHandle}`).includes(localHandle),
    false,
  );
  await fetch(url, { headers: { authorization: "Bearer wrong" } }).then(
    (response) => assert.equal(response.status, 403),
  );
  f.prepared.release();
  await assert.rejects(fetch(url, { headers }));
});

test("a server-held extension is not injected without material", async () => {
  assert.deepEqual(
    (await prepareServerHeldExtensionSession(session, [], {})).environment,
    {},
  );
});
