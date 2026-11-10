import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { prepareAppStoreConnectSession } from "../dist/connectors/appstoreconnect.js";
import { redactTranscriptText } from "../dist/platform/secret-redaction.js";

const localHandle = "fdyasc_user_fixture_local";
const renewedHandle = "fdyasc_user_fixture_renewed";
const material = {
  accountId: "asc-account",
  provider: "appstoreconnect",
  label: "Fixture team",
  tool: "asc",
  profileName: "unused",
  clientId: "ABCDEF1234",
  expiresAt: new Date(Date.now() - 1000).toISOString(),
  gateway: {
    path: "/api/connectors/appstoreconnect/gateway",
    appHandle: "",
    userHandle: localHandle,
  },
};
const session = { id: "asc-session", source: "chat", role: "chat" };

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
      body: Buffer.concat(chunks).toString(),
    });
    assert.equal(req.headers.authorization, `Bearer ${renewedHandle}`);
    assert.equal(req.headers["x-foundry-device-credential"], "fixture-device");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"data":{"id":"subscription-group","type":"subscriptionGroups"}}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  let renewals = 0;
  const prepared = await prepareAppStoreConnectSession(session, [material], {
    serverURL: `http://127.0.0.1:${server.address().port}`,
    credential: () => "fixture-device",
    renew: async (sessionId, accountId) => {
      assert.equal(sessionId, "asc-session");
      assert.equal(accountId, "asc-account");
      renewals++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        path: material.gateway.path,
        appHandle: "",
        userHandle: renewedHandle,
        expiresAt: new Date(Date.now() + 1800000).toISOString(),
      };
    },
  });
  t.after(() => prepared.release());
  return { calls, prepared, renewals: () => renewals };
}

test("App Store Connect gets only loopback gateway variables and renews its stand-in", async (t) => {
  const f = await fixture(t);
  assert.match(
    f.prepared.environment.ASC_API_BASE_URL,
    /^http:\/\/127\.0\.0\.1:\d+\/v1$/,
  );
  assert.equal(f.prepared.environment.ASC_API_TOKEN, localHandle);
  assert.equal("ASC_PRIVATE_KEY" in f.prepared.environment, false);
  assert.equal("ASC_JWT" in f.prepared.environment, false);
  const url = `${f.prepared.environment.ASC_API_BASE_URL}/apps/123/subscriptionGroups`;
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
        "/api/connectors/appstoreconnect/gateway/v1/apps/123/subscriptionGroups",
        `Bearer ${renewedHandle}`,
        "fixture-device",
      ],
      [
        "GET",
        "/api/connectors/appstoreconnect/gateway/v1/apps/123/subscriptionGroups",
        `Bearer ${renewedHandle}`,
        "fixture-device",
      ],
    ],
  );
  assert.notEqual(
    redactTranscriptText(`token ${localHandle}`).includes(localHandle),
    true,
  );
  await fetch(url, { headers: { authorization: "Bearer wrong" } }).then(
    (response) => assert.equal(response.status, 403),
  );
  f.prepared.release();
  await assert.rejects(fetch(url, { headers }));
});

test("App Store Connect is not injected without its material", async () => {
  assert.deepEqual(
    (await prepareAppStoreConnectSession(session, [], {})).environment,
    {},
  );
});
