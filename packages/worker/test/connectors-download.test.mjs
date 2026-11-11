import "./fixtures/native-test-homes.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import net from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

const state = mkdtempSync(join(tmpdir(), "connector-download-proxy-"));
process.env.FOUNDRY_STATE_ROOT = state;
const { downloadFile } = await import("../dist/connectors/download.js");
const {
  clearWorkerProxy,
  setWorkerProxy,
  workerProxyEnvironment,
  workerProxyPath,
} = await import("../dist/platform/server-link/server-proxy.js");

const proxyNames = [
  "FOUNDRY_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
];

function isolated(t) {
  const before = Object.fromEntries(
    proxyNames.map((name) => [name, process.env[name]]),
  );
  for (const name of proxyNames) delete process.env[name];
  clearWorkerProxy();
  t.after(() => {
    clearWorkerProxy();
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(workerProxyPath(), { force: true });
  });
}

async function listen(server, t) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  return server.address().port;
}

async function proxyServer(t) {
  const seen = [];
  const server = http.createServer();
  server.on("connect", (request, socket, head) => {
    seen.push({
      target: request.url,
      authorization: request.headers["proxy-authorization"],
    });
    const target = new URL(`http://${request.url}`);
    const upstream = net.connect({
      host: target.hostname,
      port: Number(target.port),
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
    upstream.once("connect", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
  });
  return { seen, port: await listen(server, t) };
}

test("a saved Worker proxy is used by connector downloads", async (t) => {
  isolated(t);
  const proxy = await proxyServer(t);
  const target = http.createServer((_request, response) =>
    response.end("through proxy"),
  );
  const targetPort = await listen(target, t);
  setWorkerProxy(`http://alice:secret@127.0.0.1:${proxy.port}`);
  const file = join(state, "saved-proxy.bin");
  await downloadFile(`http://127.0.0.1:${targetPort}/demo.bin`, file, {
    origins: [`http://127.0.0.1:${targetPort}`],
    maxBytes: 1024,
  });
  assert.equal(readFileSync(file, "utf8"), "through proxy");
  assert.equal(proxy.seen.length, 1);
  assert.equal(proxy.seen[0].target, `127.0.0.1:${targetPort}`);
});

test("without a saved or environment proxy a connector downloads directly", async (t) => {
  isolated(t);
  const seen = [];
  const server = http.createServer((request, response) => {
    seen.push(request.url);
    response.end("direct");
  });
  const port = await listen(server, t);
  const file = join(state, "direct.bin");
  await downloadFile(`http://127.0.0.1:${port}/demo.bin`, file, {
    origins: [`http://127.0.0.1:${port}`],
    maxBytes: 1024,
  });
  assert.equal(readFileSync(file, "utf8"), "direct");
  assert.deepEqual(seen, ["/demo.bin"]);
});

test("an environment proxy still applies without a saved setting", async (t) => {
  isolated(t);
  const proxy = await proxyServer(t);
  const target = http.createServer((_request, response) =>
    response.end("from environment"),
  );
  const targetPort = await listen(target, t);
  process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`;
  const file = join(state, "environment-proxy.bin");
  await downloadFile(`http://127.0.0.1:${targetPort}/environment.bin`, file, {
    origins: [`http://127.0.0.1:${targetPort}`],
    maxBytes: 1024,
  });
  assert.equal(readFileSync(file, "utf8"), "from environment");
  assert.equal(proxy.seen.length, 1);
});

test("download failures name the route but never reveal proxy credentials", async (t) => {
  isolated(t);
  setWorkerProxy("http://alice:secret@127.0.0.1:1");
  await assert.rejects(
    downloadFile(
      "http://downloads.example/unreachable.bin",
      join(state, "bad"),
      {
        origins: ["http://downloads.example"],
        maxBytes: 1024,
      },
    ),
    (error) =>
      /proxy http:\/\/127\.0\.0\.1:1/.test(error.message) &&
      !error.message.includes("alice") &&
      !error.message.includes("secret"),
  );
});

test("child download programs receive the same saved proxy setting", (t) => {
  isolated(t);
  setWorkerProxy("http://alice:secret@127.0.0.1:3128", ".internal");
  const environment = workerProxyEnvironment("https://downloads.example/file");
  assert.equal(environment.HTTPS_PROXY, "http://alice:secret@127.0.0.1:3128/");
  assert.equal(environment.https_proxy, environment.HTTPS_PROXY);
  assert.equal(environment.ALL_PROXY, environment.HTTPS_PROXY);
});
