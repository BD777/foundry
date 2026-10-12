import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import {
  materializeSessionAccounts,
  reapExternalAccountProfiles,
  sessionExternalAccountEnvironment,
  sessionExternalAccountNote,
  verifiedFeishuCliVersions,
} from "../dist/external-accounts.js";
import { startFeishuGatewayForwarder } from "../dist/feishu-gateway-forwarder.js";
import { sessionEnvironment } from "../dist/session-ambient.js";
import { redactTranscriptText } from "../dist/secret-redaction.js";

const appHandle = "fsg_c2Vzc2lvbi1hcHAtaGFuZGxlLTAxMjM0NTY3ODlhYmNkZWY";
const userHandle = "fsu_c2Vzc2lvbi11c2VyLWhhbmRsZS0wMTIzNDU2Nzg5YWJjZGVm";

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "fdy-xacc-"));
  return {
    home: join(root, "home"),
    manifestPath: join(root, "state", "external-account-profiles.json"),
    forwarder: async (path) => {
      assert.equal(path, "/api/feishu-gw");
      return { baseURL: "http://127.0.0.1:45678" };
    },
    feishuCliVersion: () => verifiedFeishuCliVersions[0],
  };
}

function material(overrides = {}) {
  return {
    accountId: "xacc_one",
    provider: "feishu",
    label: "Work Feishu",
    tool: "feishu-cli",
    profileName: "foundry-one-0a1b2c3d4e",
    clientId: "cli_app",
    gateway: { path: "/api/feishu-gw", appHandle, userHandle },
    expiresAt: new Date(Date.now() + 30 * 24 * 3600_000).toISOString(),
    scope: "docx:document offline_access",
    subject: "ou_1",
    displayName: "Ada",
    ...overrides,
  };
}

const chat = (id) => ({
  id,
  workspaceId: "ws_1",
  provider: "claude",
  source: "chat",
});

test("an account becomes the session's own feishu-cli profile holding only gateway stand-ins", async () => {
  const paths = scratch();
  const logs = [];
  const held = await materializeSessionAccounts(chat("sess_a"), [material()], {
    ...paths,
    log: (line) => logs.push(line),
  });
  const directory = join(
    paths.home,
    ".feishu-cli",
    "profiles",
    "foundry-one-0a1b2c3d4e",
  );
  assert.deepEqual(held.profiles, ["foundry-one-0a1b2c3d4e"]);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  for (const file of ["config.yaml", "token.json"])
    assert.equal(statSync(join(directory, file)).mode & 0o777, 0o600);

  const token = JSON.parse(readFileSync(join(directory, "token.json"), "utf8"));
  assert.equal(token.access_token, userHandle);
  assert.equal(token.app_id, "cli_app");
  assert.equal(token.token_type, "Bearer");
  assert.equal(token.scope, "docx:document offline_access");
  assert.equal("refresh_token" in token, false);
  const config = readFileSync(join(directory, "config.yaml"), "utf8");
  assert.match(config, /^app_id: "cli_app"$/m);
  assert.match(config, new RegExp(`^app_secret: "${appHandle}"$`, "m"));
  assert.match(config, /^base_url: "http:\/\/127\.0\.0\.1:45678"$/m);
  // The person's own pointer is never touched.
  assert.equal(
    existsSync(join(paths.home, ".feishu-cli", "active-profile")),
    false,
  );

  // Only documented configuration: the profile, nothing source-only.
  assert.deepEqual(sessionExternalAccountEnvironment("sess_a"), {
    FEISHU_PROFILE: "foundry-one-0a1b2c3d4e",
  });
  const env = sessionEnvironment(
    "/w",
    { id: "p", runtime: "claude" },
    chat("sess_a"),
  );
  assert.equal(env.FEISHU_PROFILE, "foundry-one-0a1b2c3d4e");
  assert.equal(env.FEISHU_TAT_ENDPOINT, undefined);
  assert.equal(env.FEISHU_USER_ACCESS_TOKEN, undefined);
  assert.equal(env.FEISHU_APP_SECRET, undefined);
  const note = sessionExternalAccountNote("sess_a");
  assert.match(
    note,
    /Work Feishu \(Ada\): feishu-cli profile foundry-one-0a1b2c3d4e/,
  );
  assert.match(note, /do not run feishu-cli auth login/i);
  assert.match(note, /holds no app secret or token/);
  assert.match(note, /auth token --as bot/);
  assert.match(note, /markdown fetch --as bot/);
  assert.doesNotMatch(note, /not a version|verified its Feishu gateway with/);
  assert.equal(note.includes(appHandle) || note.includes(userHandle), false);
  assert.deepEqual(
    JSON.parse(readFileSync(paths.manifestPath, "utf8")).profiles,
    [directory],
  );
  // What an agent prints of a handle never reaches a transcript.
  assert.equal(
    redactTranscriptText(`cat → ${appHandle} / ${userHandle}`).includes(
      userHandle,
    ),
    false,
  );
  assert.equal(
    redactTranscriptText(`secret ${appHandle}`).includes(appHandle),
    false,
  );

  held.release();
  held.release();
  assert.equal(existsSync(directory), false);
  assert.deepEqual(sessionExternalAccountEnvironment("sess_a"), {});
  assert.equal(sessionExternalAccountNote("sess_a"), "");
  assert.deepEqual(
    JSON.parse(readFileSync(paths.manifestPath, "utf8")).profiles,
    [],
  );
  assert.equal(
    logs.some((line) => line.includes(appHandle) || line.includes(userHandle)),
    false,
  );
});

test("two sessions on one account each have their own profile", async () => {
  const paths = scratch();
  const first = await materializeSessionAccounts(
    chat("sess_b1"),
    [material({ profileName: "foundry-two-1111111111" })],
    paths,
  );
  const second = await materializeSessionAccounts(
    chat("sess_b2"),
    [material({ profileName: "foundry-two-2222222222" })],
    paths,
  );
  const profiles = join(paths.home, ".feishu-cli", "profiles");
  first.release();
  assert.equal(existsSync(join(profiles, "foundry-two-1111111111")), false);
  assert.equal(
    existsSync(join(profiles, "foundry-two-2222222222", "token.json")),
    true,
  );
  assert.deepEqual(sessionExternalAccountEnvironment("sess_b2"), {
    FEISHU_PROFILE: "foundry-two-2222222222",
  });
  second.release();
  assert.equal(existsSync(join(profiles, "foundry-two-2222222222")), false);
});

test("sessions outside the person's HOME, old-style secrets, other tools and bad names get nothing", async () => {
  const paths = scratch();
  for (const session of [
    { ...chat("sess_issue"), issueId: "iss_1" },
    { ...chat("sess_name"), source: "naming" },
    { ...chat("sess_verify"), source: "verification" },
    { ...chat("sess_clar"), role: "issue_clarification" },
  ]) {
    const held = await materializeSessionAccounts(session, [material()], paths);
    assert.deepEqual(held.profiles, [], session.id);
    assert.deepEqual(sessionExternalAccountEnvironment(session.id), {});
  }
  for (const odd of [
    material({ tool: "gh" }),
    material({ profileName: "default" }),
    material({ profileName: "foundry-../../escape" }),
    material({ gateway: undefined }),
    // What a server before the gateway sent: a secret and a real token.
    material({
      gateway: undefined,
      clientSecret: "real-secret",
      accessToken: "u-real",
    }),
    material({
      gateway: { path: "/api/feishu-gw", appHandle, userHandle: "" },
    }),
  ])
    assert.deepEqual(
      (await materializeSessionAccounts(chat("sess_odd"), [odd], paths))
        .profiles,
      [],
    );
  assert.equal(existsSync(join(paths.home, ".feishu-cli")), false);
});

test("a feishu-cli version the gateway was not verified with is reported", async () => {
  const paths = scratch();
  const logs = [];
  const held = await materializeSessionAccounts(chat("sess_v"), [material()], {
    ...paths,
    feishuCliVersion: () => "1.99.0",
    log: (line) => logs.push(line),
  });
  const note = sessionExternalAccountNote("sess_v");
  assert.match(note, /feishu-cli on this device is 1\.99\.0/);
  assert.match(
    note,
    new RegExp(verifiedFeishuCliVersions[0].replace(/\./g, "\\.")),
  );
  assert.match(
    logs.join("\n"),
    /feishu-cli 1\.99\.0 on this device is not a version/,
  );
  held.release();
});

test("a profile whose forwarder cannot start is not written", async () => {
  const paths = scratch();
  const logs = [];
  const held = await materializeSessionAccounts(chat("sess_f"), [material()], {
    ...paths,
    forwarder: async () => {
      throw new Error("no port");
    },
    log: (line) => logs.push(line),
  });
  assert.deepEqual(held.profiles, []);
  assert.match(
    logs.join("\n"),
    /could not set up its feishu-cli profile \(no port\)/,
  );
  assert.equal(
    existsSync(
      join(paths.home, ".feishu-cli", "profiles", "foundry-one-0a1b2c3d4e"),
    ),
    false,
  );
});

test("a restarted worker removes the profiles its predecessor left, and nothing else", () => {
  const paths = scratch();
  const profiles = join(paths.home, ".feishu-cli", "profiles");
  const leftover = join(profiles, "foundry-left");
  const own = join(profiles, "default");
  const unlisted = join(profiles, "foundry-other-worker");
  for (const directory of [leftover, own, unlisted]) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "token.json"), "{}");
  }
  mkdirSync(join(paths.manifestPath, ".."), { recursive: true });
  writeFileSync(
    paths.manifestPath,
    JSON.stringify({ profiles: [leftover, own] }),
  );
  assert.deepEqual(reapExternalAccountProfiles(paths), [leftover]);
  assert.equal(existsSync(leftover), false);
  assert.equal(existsSync(own), true);
  assert.equal(existsSync(unlisted), true);
  assert.deepEqual(
    JSON.parse(readFileSync(paths.manifestPath, "utf8")).profiles,
    [],
  );
});

async function listen(server) {
  await new Promise((settle) => server.listen(0, "127.0.0.1", settle));
  return `http://127.0.0.1:${server.address().port}`;
}

function send(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((settle, reject) => {
    const outgoing = request(url, { method, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () =>
        settle({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }),
      );
    });
    outgoing.on("error", reject);
    if (body) outgoing.end(body);
    else outgoing.end();
  });
}

test("the forwarder streams feishu-cli's calls to the gateway with the device credential", async (t) => {
  const seen = [];
  const blob = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
  const server = createServer((incoming, response) => {
    let size = 0;
    incoming.on("data", (chunk) => (size += chunk.length));
    incoming.on("end", () => {
      seen.push({
        method: incoming.method,
        url: incoming.url,
        credential: incoming.headers["x-foundry-device-credential"],
        forwarderHost: incoming.headers["x-foundry-forwarder-host"],
        authorization: incoming.headers.authorization,
        range: incoming.headers.range,
        size,
      });
      if (incoming.headers.range) {
        response.writeHead(206, {
          "content-range": "bytes 0-9/100",
          "x-ogw-ratelimit-reset": "3",
        });
        response.end(Buffer.alloc(10, 1));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: 0, size }));
    });
  });
  const serverURL = await listen(server);
  t.after(() => server.close());
  const forwarder = await startFeishuGatewayForwarder({
    serverURL,
    gatewayPath: "/api/feishu-gw",
    credential: () => "device-credential-1",
  });
  t.after(() => forwarder.close());
  assert.match(forwarder.baseURL, /^http:\/\/127\.0\.0\.1:\d+$/);

  const uploaded = await send(
    `${forwarder.baseURL}/open-apis/drive/v1/files/upload_part?x=1`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${userHandle}`,
        "x-foundry-device-credential": "forged",
        "content-type": "multipart/form-data; boundary=b",
      },
      body: blob,
    },
  );
  assert.equal(uploaded.status, 200);
  assert.equal(JSON.parse(uploaded.body.toString()).size, blob.length);
  const ranged = await send(
    `${forwarder.baseURL}/open-apis/drive/v1/files/f/download`,
    {
      headers: { authorization: `Bearer ${userHandle}`, range: "bytes=0-9" },
    },
  );
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers["x-ogw-ratelimit-reset"], "3");
  assert.equal(ranged.body.length, 10);
  const host = forwarder.baseURL.slice("http://".length);
  assert.deepEqual(seen, [
    {
      method: "POST",
      url: "/api/feishu-gw/open-apis/drive/v1/files/upload_part?x=1",
      credential: "device-credential-1",
      forwarderHost: host,
      authorization: `Bearer ${userHandle}`,
      range: undefined,
      size: blob.length,
    },
    {
      method: "GET",
      url: "/api/feishu-gw/open-apis/drive/v1/files/f/download",
      credential: "device-credential-1",
      forwarderHost: host,
      authorization: `Bearer ${userHandle}`,
      range: "bytes=0-9",
      size: 0,
    },
  ]);
});

test("the forwarder relays the event socket and a refused upgrade", async (t) => {
  const upgrades = [];
  const server = createServer((_incoming, response) => response.end());
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (incoming, socket, head) => {
    upgrades.push({
      url: incoming.url,
      credential: incoming.headers["x-foundry-device-credential"],
    });
    if (incoming.url.includes("refuse")) {
      socket.end(
        'HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\ncontent-length: 13\r\n\r\n{"code":1234}',
      );
      return;
    }
    sockets.handleUpgrade(incoming, socket, head, (ws) =>
      ws.on("message", (data, binary) => ws.send(data, { binary })),
    );
  });
  const serverURL = await listen(server);
  t.after(() => {
    sockets.close();
    server.close();
  });
  const forwarder = await startFeishuGatewayForwarder({
    serverURL,
    gatewayPath: "/api/feishu-gw",
    credential: () => "device-credential-2",
  });
  t.after(() => forwarder.close());
  const wsBase = forwarder.baseURL.replace("http://", "ws://");
  const client = new WebSocket(
    `${wsBase}/foundry/event-socket?foundry_ticket=t1&device_id=d`,
  );
  const echoed = await new Promise((settle, reject) => {
    client.on("open", () => client.send(Buffer.from([1, 2, 3])));
    client.on("message", (data) => settle(Buffer.from(data)));
    client.on("error", reject);
  });
  client.close();
  assert.deepEqual([...echoed], [1, 2, 3]);
  assert.deepEqual(upgrades[0], {
    url: "/api/feishu-gw/foundry/event-socket?foundry_ticket=t1&device_id=d",
    credential: "device-credential-2",
  });
  const refused = new WebSocket(`${wsBase}/foundry/event-socket?refuse=1`);
  const status = await new Promise((settle) => {
    refused.on("unexpected-response", (_request, response) =>
      settle(response.statusCode),
    );
    refused.on("error", () => settle("error"));
  });
  assert.equal(status, 401);
});
