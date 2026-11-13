import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocketServer } from "ws";
import { shouldRestartForServerSilence } from "../dist/platform/server-link/server-contact.js";

const cli = resolve(import.meta.dirname, "../dist/cli.js");

test("server silence restarts the Worker, never under turns it runs itself", () => {
  const base = { now: 1_000_000, limitMs: 300_000, turnsInThisProcess: 0 };
  assert.equal(
    shouldRestartForServerSilence({
      ...base,
      lastContactAt: base.now - 299_000,
    }),
    false,
  );
  assert.equal(
    shouldRestartForServerSilence({
      ...base,
      lastContactAt: base.now - 301_000,
    }),
    true,
  );
  assert.equal(
    shouldRestartForServerSilence({
      ...base,
      lastContactAt: base.now - 301_000,
      turnsInThisProcess: 1,
    }),
    false,
  );
});

/** A paired daemon in its own state root, against a local fake server. */
async function startDaemon(
  t,
  { acceptSockets = true, env: extra = {}, proxy } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "foundry-daemon-contact-"));
  const stateRoot = join(root, "state");
  mkdirSync(stateRoot);
  const env = {
    ...process.env,
    FOUNDRY_STATE_ROOT: stateRoot,
    FOUNDRY_STACK: "",
    ...extra,
  };
  for (const name of [
    "FOUNDRY_PROXY",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
  ])
    delete env[name];
  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });
  const sockets = new WebSocketServer({ noServer: true });
  const hellos = [];
  const closes = [];
  server.on("upgrade", (request, socket, head) => {
    if (!acceptSockets) {
      socket.end(
        "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }
    sockets.handleUpgrade(request, socket, head, (connection) => {
      connection.on("close", (code, reason) =>
        closes.push({ code, reason: String(reason) }),
      );
      connection.on("message", (raw) => {
        const envelope = JSON.parse(String(raw));
        if (envelope.type !== "hello") return;
        hellos.push(envelope.payload);
        connection.send(
          JSON.stringify({ id: envelope.id, type: "registered" }),
        );
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const serverURL = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(
    join(stateRoot, "daemon-config.json"),
    JSON.stringify({
      pairedAt: new Date().toISOString(),
      deviceCredential: "test-credential",
      serverURL,
      workspacePath: "",
    }),
  );
  if (proxy)
    writeFileSync(join(stateRoot, "worker-proxy.json"), JSON.stringify(proxy));
  const daemon = spawn(
    process.execPath,
    [cli, "daemon", "--server", serverURL],
    {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  const output = { stderr: "" };
  daemon.stderr.on("data", (chunk) => (output.stderr += chunk));
  t.after(() => {
    daemon.kill("SIGKILL");
    for (const client of sockets.clients) client.terminate();
    sockets.close();
    server.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { stateRoot, daemon, hellos, closes, output, env };
}

async function until(condition, ms, what, output) {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline)
    await new Promise((settle) => setTimeout(settle, 50));
  assert.ok(condition(), `${what}: ${output.stderr}`);
}

// DEV-217: the Mac mini's Worker closed its socket (1000) on its own and made
// no attempt the server saw for over 30 minutes. A proxy file that failed to
// read counted as a change; every reconnect then failed on the same read
// before reaching the network.
test("a proxy file that fails to read neither closes the connection nor stops reconnects", async (t) => {
  // Direct to this server either way: the loopback host bypasses the proxy.
  const { stateRoot, hellos, closes, output } = await startDaemon(t, {
    proxy: { url: "http://127.0.0.1:9", noProxy: "127.0.0.1" },
  });
  const proxyFile = join(stateRoot, "worker-proxy.json");
  await until(
    () => hellos.length >= 1,
    60_000,
    "the daemon never said hello",
    output,
  );
  const before = hellos.length;
  writeFileSync(proxyFile, "{ half written");
  // The watcher polls each second; a loaded machine delays it.
  await until(
    () =>
      /unreadable or invalid \(malformed JSON\)\. .* Not a change/.test(
        output.stderr,
      ),
    30_000,
    "the failed read was not logged",
    output,
  );
  await new Promise((settle) => setTimeout(settle, 1500));
  assert.deepEqual(closes, [], output.stderr);
  assert.equal(hellos.length, before);
  // A real change reconnects, says why, and the new socket reaches the server
  // although the file breaks again right after it was read.
  writeFileSync(
    proxyFile,
    JSON.stringify({
      url: "http://127.0.0.1:9",
      noProxy: "127.0.0.1,localhost",
    }),
  );
  await until(
    () => closes.length >= 1,
    30_000,
    "the change did not close the socket",
    output,
  );
  writeFileSync(proxyFile, "{ half written again");
  assert.equal(closes[0].code, 1000);
  assert.equal(closes[0].reason, "Worker proxy configuration changed");
  await until(
    () => hellos.length > before,
    45_000,
    "the daemon did not reconnect",
    output,
  );
  assert.match(
    output.stderr,
    /Worker proxy configuration changed \(http:\/\/127\.0\.0\.1:9 no-proxy "127\.0\.0\.1" -> http:\/\/127\.0\.0\.1:9 no-proxy "127\.0\.0\.1,localhost"\); reconnecting\./,
  );
});

test("a Worker that hears nothing from the server ends with a status its service manager restarts", async (t) => {
  const { daemon, output } = await startDaemon(t, {
    acceptSockets: false,
    env: { FOUNDRY_SERVER_CONTACT_LIMIT_MS: "3000" },
  });
  const [code] = await Promise.race([
    once(daemon, "exit"),
    new Promise((settle) => setTimeout(() => settle(["timeout"]), 60_000)),
  ]);
  assert.equal(code, 75, output.stderr);
  assert.match(
    output.stderr,
    /Nothing from the server for \d+s; restarting the Worker\./,
  );
});

// DEV-217: a dead proxy in worker-proxy.json kept the Mac mini offline for
// three hours. Past the threshold the Worker connects directly and says so.
test("a Worker whose configured proxy is dead connects directly and reports it", async (t) => {
  const { hellos, output } = await startDaemon(t, {
    proxy: { url: "http://user:secret@127.0.0.1:1" },
    env: {
      FOUNDRY_PROXY_FALLBACK_FAILURES: "2",
      FOUNDRY_PROXY_FALLBACK_AFTER_MS: "1000",
    },
  });
  await until(
    () => hellos.length >= 1,
    90_000,
    "the daemon never reached the server",
    output,
  );
  const fallback = hellos[0].device.worker.proxyFallback;
  assert.equal(fallback.route, "direct");
  assert.equal(fallback.configured, "http://127.0.0.1:1");
  const leaked = JSON.stringify(hellos[0]);
  assert.equal(
    leaked.includes("user:secret"),
    false,
    leaked.slice(
      Math.max(0, leaked.indexOf("secret") - 300),
      leaked.indexOf("secret") + 100,
    ),
  );
  assert.match(
    output.stderr,
    /WORKER PROXY UNREACHABLE: \d+ connection attempts through http:\/\/127\.0\.0\.1:1 failed/,
  );
});
