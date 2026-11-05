import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareCloudflareSession } from "../dist/connectors/cloudflare.js";

const localHandle = "fdycf_user_fixture_local";
const material = {
  accountId: "cf-account",
  provider: "cloudflare",
  label: "Fixture",
  tool: "cf",
  profileName: "unused",
  clientId: "public",
  expiresAt: new Date(Date.now() - 1000).toISOString(),
  gateway: {
    path: "/api/connectors/cloudflare/gateway",
    appHandle: "",
    userHandle: localHandle,
  },
};
const session = { id: "cf-session", source: "chat", role: "chat" };
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
    assert.equal(
      req.headers.authorization,
      "Bearer fdycf_user_fixture_renewed",
    );
    assert.equal(req.headers["x-foundry-device-credential"], "fixture-device");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        success: true,
        errors: [],
        messages: [],
        result: [
          {
            id: "a".repeat(32),
            name: "fixture.invalid",
            status: "active",
            type: "full",
            account: { id: "b".repeat(32), name: "Fixture account" },
          },
        ],
        result_info: {
          page: 1,
          per_page: 50,
          total_pages: 1,
          total_count: 1,
          count: 1,
        },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  let renewals = 0;
  const prepared = await prepareCloudflareSession(session, [material], {
    serverURL: `http://127.0.0.1:${server.address().port}`,
    credential: () => "fixture-device",
    renew: async (sessionId, accountId) => {
      assert.equal(sessionId, "cf-session");
      assert.equal(accountId, "cf-account");
      renewals++;
      await new Promise((r) => setTimeout(r, 5));
      return {
        path: material.gateway.path,
        appHandle: "",
        userHandle: "fdycf_user_fixture_renewed",
        expiresAt: new Date(Date.now() + 1800000).toISOString(),
      };
    },
  });
  t.after(() => prepared.release());
  return { calls, prepared, renewals: () => renewals };
}
test("Cloudflare CLI forwarder renews only the scoped stand-in, passes every method to the server and blocks wrong handles", async (t) => {
  const f = await fixture(t);
  const url = f.prepared.environment.CLOUDFLARE_API_BASE_URL + "/zones";
  const headers = {
    authorization: `Bearer ${localHandle}`,
    "X-Foundry-Device-Credential": "forged",
  };
  const replies = await Promise.all([
    fetch(url, { headers }),
    fetch(url, { headers }),
  ]);
  for (const r of replies) assert.equal(r.status, 200);
  assert.equal(f.renewals(), 1);
  assert.equal(f.calls.length, 2);
  assert.equal(
    f.calls[0].path,
    "/api/connectors/cloudflare/gateway/client/v4/zones",
  );
  assert.equal(
    (await fetch(url, { headers: { authorization: "Bearer wrong" } })).status,
    403,
  );
  // The forwarder only carries: whether a change is allowed is the server's
  // decision, so each method arrives with the renewed stand-in and its body.
  for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
    const answer = await fetch(url, {
      method,
      headers: { ...headers, "content-type": "application/json" },
      ...(method === "DELETE" ? {} : { body: '{"x":1}' }),
    });
    assert.equal(answer.status, 200, method);
  }
  assert.deepEqual(
    f.calls.slice(2).map((c) => [c.method, c.authorization, c.device, c.body]),
    ["POST", "PATCH", "PUT", "DELETE"].map((method) => [
      method,
      "Bearer fdycf_user_fixture_renewed",
      "fixture-device",
      method === "DELETE" ? "" : '{"x":1}',
    ]),
  );
  assert.equal(
    (
      await fetch(url, {
        method: "POST",
        headers: { authorization: "Bearer wrong" },
        body: "{}",
      })
    ).status,
    403,
  );
  assert.equal(f.calls.length, 6);
  f.prepared.release();
  await assert.rejects(fetch(url, { headers }));
});
test("cf is told its account only when the server found one account for every bound zone", async (t) => {
  const environmentFor = async (providerAccountId) => {
    const prepared = await prepareCloudflareSession(
      session,
      [{ ...material, ...(providerAccountId ? { providerAccountId } : {}) }],
      { serverURL: "http://127.0.0.1:9", credential: () => "device" },
    );
    t.after(() => prepared.release());
    return prepared.environment;
  };
  const account = "d".repeat(32);
  assert.equal((await environmentFor(account)).CLOUDFLARE_ACCOUNT_ID, account);
  for (const unknown of [undefined, "", "not-an-id", "D".repeat(32)])
    assert.equal(
      "CLOUDFLARE_ACCOUNT_ID" in (await environmentFor(unknown)),
      false,
      String(unknown),
    );
});
test("Cloudflare is not injected into a session without a material", async () => {
  assert.deepEqual(
    (await prepareCloudflareSession(session, [], {})).environment,
    {},
  );
});
test(
  "installed official cf CLI consumes the session gateway without native OAuth credentials",
  {
    skip:
      !process.env.CF_CLI_TEST_BINARY ||
      !existsSync(process.env.CF_CLI_TEST_BINARY),
  },
  async (t) => {
    const f = await fixture(t);
    const config = mkdtempSync(join(tmpdir(), "cf-gateway-contract-"));
    const result = await new Promise((resolve, reject) =>
      execFile(
        process.env.CF_CLI_TEST_BINARY,
        ["zones", "list"],
        {
          cwd: config,
          env: {
            ...process.env,
            ...f.prepared.environment,
            XDG_CONFIG_HOME: config,
            CI: "1",
            NO_COLOR: "1",
          },
          timeout: 25000,
          maxBuffer: 1024 * 1024,
        },
        (error, stdout, stderr) =>
          error
            ? reject(new Error(`official cf failed: ${stdout} ${stderr}`))
            : resolve({ stdout, stderr }),
      ),
    );
    assert.match(result.stdout, /fixture\.invalid/);
    assert.equal(f.renewals(), 1);
    assert.ok(
      f.calls.some((x) =>
        x.path.startsWith("/api/connectors/cloudflare/gateway/client/v4/zones"),
      ),
    );
    assert.doesNotMatch(result.stdout, /fdycf_user/);
  },
);
