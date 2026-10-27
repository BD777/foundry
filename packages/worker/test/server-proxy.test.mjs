import "./fixtures/native-test-homes.mjs";
import {
  buildClaudeLaunchPlan,
  codexFoundryTools,
} from "../dist/session-policy.js";
import { registerSessionAmbientEnv } from "../dist/session-ambient.js";
import {
  startServerMcpForwarder,
  serverMcpURL,
} from "../dist/server-mcp-forwarder.js";
import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { once } from "node:events";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import WebSocket, { WebSocketServer } from "ws";
import {
  serverFetch,
  serverWebSocketAgent,
  setWorkerProxy,
  clearWorkerProxy,
  resolveServerProxy,
  describeProxy,
  workerProxyPath,
  watchWorkerProxy,
} from "../dist/server-proxy.js";
import {
  serverWorkerRelease,
  withDownloadedWorkerPackages,
} from "../dist/worker-install.js";
import { FoundryClient } from "../dist/foundry-client.js";
import { startFeishuGatewayForwarder } from "../dist/connectors/feishu-gateway-forwarder.js";
import {
  redactSecrets,
  redactTranscriptText,
} from "../dist/secret-redaction.js";

async function listen(server, t) {
  const sockets = new Set();
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    for (const s of sockets) s.destroy();
    server.close();
  });
  return server.address().port;
}
function tunnel(client, host, port, head = Buffer.alloc(0)) {
  const upstream = net.connect({ host, port });
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
  return new Promise((resolve) =>
    upstream.once("connect", () => {
      resolve(upstream);
      if (head.length) upstream.write(head);
    }),
  );
}
async function connectProxy(t, tls, credentials) {
  const server = tls ? https.createServer(tls) : http.createServer();
  const seen = [];
  server.on("connect", async (req, socket, head) => {
    seen.push({ target: req.url, auth: req.headers["proxy-authorization"] });
    if (
      credentials &&
      req.headers["proxy-authorization"] !==
        `Basic ${Buffer.from(credentials).toString("base64")}`
    ) {
      socket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
      return;
    }
    const url = new URL(`http://${req.url}`);
    const upstream = await tunnel(socket, url.hostname, Number(url.port), head);
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.pipe(upstream).pipe(socket);
  });
  return { port: await listen(server, t), seen };
}
async function bytes(socket, n) {
  while (true) {
    const data = socket.read(n);
    if (data) return data;
    await Promise.race([
      once(socket, "readable"),
      once(socket, "close").then(() => {
        throw new Error("socket closed");
      }),
    ]);
  }
}
async function socksProxy(t, credentials) {
  const seen = [];
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    void (async () => {
      const greeting = await bytes(socket, 2);
      await bytes(socket, greeting[1]);
      socket.write(Buffer.from([5, credentials ? 2 : 0]));
      let auth;
      if (credentials) {
        const start = await bytes(socket, 2);
        const user = await bytes(socket, start[1]);
        const len = await bytes(socket, 1);
        const pass = await bytes(socket, len[0]);
        auth = `${user}:${pass}`;
        socket.write(Buffer.from([1, auth === credentials ? 0 : 1]));
        if (auth !== credentials) {
          socket.end();
          return;
        }
      }
      const request = await bytes(socket, 4);
      let host;
      if (request[3] === 1) host = [...(await bytes(socket, 4))].join(".");
      else if (request[3] === 3) {
        const len = await bytes(socket, 1);
        host = (await bytes(socket, len[0])).toString();
      } else throw new Error("unsupported test address");
      const port = (await bytes(socket, 2)).readUInt16BE();
      seen.push({ host, port, auth, type: request[3] });
      const upstream = await tunnel(
        socket,
        host === "only-proxy.invalid" ? "127.0.0.1" : host,
        port,
      );
      socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
      socket.pipe(upstream).pipe(socket);
    })().catch(() => socket.destroy());
  });
  return { port: await listen(server, t), seen };
}
function isolated(t) {
  const before = { ...process.env };
  const root = mkdtempSync(join(tmpdir(), "foundry-proxy-test-"));
  for (const name of [
    "FOUNDRY_PROXY",
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
  ])
    delete process.env[name];
  process.env.FOUNDRY_STATE_ROOT = root;
  t.after(() => {
    process.env = before;
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}
async function echoSocket(url, agent) {
  const ws = new WebSocket(url, { agent });
  try {
    await once(ws, "open");
    ws.send("proxy hello");
    const [body] = await once(ws, "message");
    assert.equal(body.toString(), "proxy hello");
  } finally {
    ws.terminate();
    agent?.destroy();
  }
}
function attachEcho(server, t) {
  const ws = new WebSocketServer({ server });
  ws.on("connection", (s) => s.on("message", (data) => s.send(data)));
  t.after(() => {
    for (const s of ws.clients) s.terminate();
    ws.close();
  });
}

for (const scheme of ["http", "socks5", "socks5h"])
  test(`${scheme}: authenticated fetch, WS, streaming upload/download and self-update tarballs`, async (t) => {
    isolated(t);
    const secrets = "username:p%40ss";
    const credential = "username:p@ss";
    const proxy =
      scheme === "http"
        ? await connectProxy(t, undefined, credential)
        : await socksProxy(t, credential);
    const requests = [];
    const payload = Buffer.alloc(192 * 1024, 65);
    const server = http.createServer(async (req, res) => {
      requests.push(req.headers);
      if (req.url === "/api/worker/release") {
        res.end(
          JSON.stringify({ source: "server", version: "test", packages: [] }),
        );
        return;
      }
      if (req.method === "POST") {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        res.end(Buffer.concat(chunks));
        return;
      }
      res.write(payload.subarray(0, 45000));
      setImmediate(() => res.end(payload.subarray(45000)));
    });
    attachEcho(server, t);
    const port = await listen(server, t);
    const host = scheme === "socks5h" ? "only-proxy.invalid" : "127.0.0.1";
    const target = `http://${host}:${port}`;
    setWorkerProxy(`${scheme}://${secrets}@127.0.0.1:${proxy.port}`);
    assert.equal(statSync(workerProxyPath()).mode & 0o777, 0o600);
    let response = await serverFetch(target);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload);
    async function* upload() {
      yield payload.subarray(0, 50000);
      yield payload.subarray(50000);
    }
    response = await serverFetch(target, {
      method: "POST",
      body: upload(),
      duplex: "half",
    });
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload);
    await echoSocket(`ws://${host}:${port}`, serverWebSocketAgent(target));
    assert.equal((await serverWorkerRelease(target, [])).version, "test");
    const client = new FoundryClient({
      serverURL: target,
      deviceCredential: "synthetic-device",
    });
    const rpc = { jsonrpc: "2.0", id: 1, method: "initialize" };
    assert.deepEqual(await client.mcp(rpc), rpc);
    const stopMcp = await startServerMcpForwarder(target);
    try {
      const url = serverMcpURL(`${target}/api/mcp`);
      assert.match(url, /^http:\/\/127.0.0.1:/);
      const session = {
        id: "sess_proxy_native",
        provider: "claude",
        profileId: "claude_local",
        workspaceId: "ws_proxy",
        prompt: "test",
        input: { id: "input_proxy", prompt: "test" },
      };
      const releaseAmbient = registerSessionAmbientEnv(session.id, {
        serverURL: target,
        sessionToken: "session-scoped",
        workspaceID: "ws_proxy",
      });
      try {
        assert.equal(
          codexFoundryTools(session).config.mcp_servers.foundry.url,
          url,
        );
        const plan = buildClaudeLaunchPlan({
          workspacePath: process.env.FOUNDRY_STATE_ROOT,
          session,
          profile: {
            id: "claude_local",
            runtime: "claude",
            label: "test",
            connectionType: "local_login",
          },
        });
        assert.equal(plan.mcpServers.foundry.url, url);
        assert.equal(
          plan.mcpServers.foundry.headers.Authorization,
          "Bearer session-scoped",
        );
        assert.equal(plan.env.FOUNDRY_PROXY, undefined);
      } finally {
        releaseAmbient();
      }

      const mcpResponse = await fetch(url, {
        method: "POST",
        headers: { Authorization: "Bearer session-scoped" },
        body: JSON.stringify(rpc),
      });
      assert.deepEqual(await mcpResponse.json(), rpc);
      assert.equal(
        (await fetch(url.replace("/api/mcp", "/api/devices"))).status,
        404,
      );
      assert.equal(requests.at(-1).authorization, "Bearer session-scoped");
      assert.equal(requests.at(-1)["x-foundry-device-credential"], undefined);
    } finally {
      stopMcp();
    }

    const forwarder = await startFeishuGatewayForwarder({
      serverURL: target,
      gatewayPath: "/gateway",
      credential: () => "synthetic-device",
    });
    try {
      const relayed = await fetch(forwarder.baseURL, {
        method: "POST",
        body: payload,
      });
      assert.deepEqual(Buffer.from(await relayed.arrayBuffer()), payload);
      const ws = new WebSocket(forwarder.baseURL.replace("http:", "ws:"));
      await once(ws, "open");
      ws.send("relay echo");
      assert.equal((await once(ws, "message"))[0].toString(), "relay echo");
      ws.terminate();
    } finally {
      await forwarder.close();
    }

    let downloaded;
    await withDownloadedWorkerPackages(
      [`${target}/worker.tgz`],
      async ([file]) => {
        downloaded = file;
        assert.deepEqual(readFileSync(file), payload);
      },
    );
    assert.equal(existsSync(downloaded), false);
    if (scheme === "socks5") {
      const before = proxy.seen.length;
      await assert.rejects(serverFetch(`http://only-proxy.invalid:${port}`));
      assert.equal(
        proxy.seen.length,
        before,
        "socks5 resolves names locally before contacting the proxy",
      );
    }
    assert.ok(proxy.seen.length >= 2);
    if (scheme === "socks5h")
      assert.ok(proxy.seen.every((s) => s.type === 3 && s.host === host));
    for (const headers of requests) {
      assert.equal(headers["proxy-authorization"], undefined);
      assert.equal(JSON.stringify(headers).includes("p@ss"), false);
    }
  });

test("precedence, host/port/IPv6 bypass, config watcher and credential-safe CLI", async (t) => {
  isolated(t);
  process.env.ALL_PROXY = "socks5h://fallback:1080";
  process.env.HTTPS_PROXY = "http://standard:3128";
  process.env.FOUNDRY_PROXY = "https://specific:8443";
  assert.equal(
    describeProxy(resolveServerProxy("https://server").url),
    "https://specific:8443",
  );
  setWorkerProxy(
    "socks5h://user:secret@explicit:1080",
    ".corp,localhost:8080,[::1]",
  );
  assert.equal(resolveServerProxy("https://server").source, "setting");
  for (const url of [
    "https://foo.corp",
    "http://localhost:8080",
    "http://[::1]",
  ])
    assert.equal(resolveServerProxy(url).url, undefined);
  assert.ok(resolveServerProxy("http://localhost:8081").url);
  const changed = new Promise((resolve) => {
    const stop = watchWorkerProxy(() => {
      stop();
      resolve();
    });
  });
  // The watcher does not hold the process open (the daemon has its own
  // handles); here nothing else would, so keep the loop alive while waiting.
  const alive = setInterval(() => {}, 1000);
  clearWorkerProxy();
  await changed;
  clearInterval(alive);
  assert.equal(resolveServerProxy("https://server").source, "FOUNDRY_PROXY");
  const saved = await runNode([
    "../dist/cli.js",
    "proxy",
    "set",
    "socks5h://user:secret@localhost:1080",
    "--no-proxy",
    "",
  ]);
  assert.equal(saved.code, 0, saved.stderr);
  const shown = await runNode(["../dist/cli.js", "proxy", "show"]);
  assert.equal(shown.code, 0, shown.stderr);
  assert.equal(shown.stdout.includes("secret"), false);
  assert.match(shown.stdout, /socks5h:\/\/localhost:1080/);
  const cli = await runNode([
    "../dist/cli.js",
    "proxy",
    "set",
    "https://user:secret@host:123/path",
  ]);
  assert.equal(cli.code, 1);
  assert.equal(cli.stdout.includes("secret"), false);
  assert.equal(cli.stderr.includes("secret"), false);
  const malformed = await runNode([
    "../dist/cli.js",
    "proxy",
    "set",
    "http://user:raw/secret@host",
  ]);
  assert.equal(malformed.code, 1);
  assert.equal(malformed.stderr.includes("raw/secret"), false);

  for (const redact of [redactSecrets, redactTranscriptText])
    assert.equal(
      redact("socks5h://user:secret@host:1080").includes("secret"),
      false,
    );
});

test("NO_PROXY bypasses a dead proxy; failures identify route without userinfo", async (t) => {
  isolated(t);
  const server = http.createServer((_, res) => res.end("direct"));
  attachEcho(server, t);
  const port = await listen(server, t);
  setWorkerProxy("http://user:secret@127.0.0.1:1", "127.0.0.1");
  const target = `http://127.0.0.1:${port}`;
  assert.equal(await (await serverFetch(target)).text(), "direct");
  assert.equal(serverWebSocketAgent(target).constructor.name, "Agent");
  await echoSocket(
    target.replace("http:", "ws:"),
    serverWebSocketAgent(target),
  );
  setWorkerProxy("socks5h://user:secret@127.0.0.1:1");
  await assert.rejects(
    serverFetch(target),
    (e) =>
      /proxy socks5h:\/\/127.0.0.1:1/.test(e.message) &&
      !JSON.stringify(e).includes("secret") &&
      !String(e).includes("user"),
  );
});

async function runNode(args, env = {}) {
  const child = spawn(process.execPath, args, {
    cwd: new URL(".", import.meta.url),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (b) => (stdout += b));
  child.stderr.on("data", (b) => (stderr += b));
  const [code] = await once(child, "close");
  return { code, stdout, stderr };
}

test("HTTPS proxy + HTTPS target retain certificate validation; SOCKS5h WSS uses remote DNS", async (t) => {
  const root = isolated(t);
  const key = join(root, "key.pem"),
    cert = join(root, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,DNS:only-proxy.invalid,IP:127.0.0.1",
      "-days",
      "1",
    ],
    { stdio: "ignore" },
  );
  const tls = { key: readFileSync(key), cert: readFileSync(cert) };
  const proxy = await connectProxy(t, tls, "user:secret");
  const socks = await socksProxy(t);
  const server = https.createServer(tls, (_, res) => res.end("secure"));
  attachEcho(server, t);
  const port = await listen(server, t);
  const script = `import {serverFetch,serverWebSocketAgent} from '../dist/server-proxy.js'; import WebSocket from 'ws'; import {once} from 'node:events'; const url=process.env.TARGET; const r=await serverFetch(url); console.log(await r.text()); const ws=new WebSocket(url.replace('https:', 'wss:'),{agent:serverWebSocketAgent(url)}); await once(ws,'open'); ws.send('tls echo'); console.log((await once(ws,'message'))[0].toString()); ws.terminate();`;
  const trusted = await runNode(["--input-type=module", "-e", script], {
    NODE_EXTRA_CA_CERTS: cert,
    FOUNDRY_PROXY: `https://user:secret@127.0.0.1:${proxy.port}`,
    TARGET: `https://127.0.0.1:${port}`,
  });
  assert.equal(trusted.code, 0, trusted.stderr);
  assert.match(trusted.stdout, /secure\ntls echo/);
  const untrusted = await runNode(["--input-type=module", "-e", script], {
    FOUNDRY_PROXY: `https://user:secret@127.0.0.1:${proxy.port}`,
    TARGET: `https://127.0.0.1:${port}`,
  });
  assert.notEqual(untrusted.code, 0);
  assert.equal(untrusted.stderr.includes("secret"), false);
  const remote = await runNode(["--input-type=module", "-e", script], {
    NODE_EXTRA_CA_CERTS: cert,
    FOUNDRY_PROXY: `socks5h://127.0.0.1:${socks.port}`,
    TARGET: `https://only-proxy.invalid:${port}`,
  });
  assert.equal(remote.code, 0, remote.stderr);
  assert.match(remote.stdout, /secure\ntls echo/);
});
