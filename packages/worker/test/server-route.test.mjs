import test from "node:test";
import assert from "node:assert/strict";
import {
  clearWorkerProxy,
  onServerRouteChange,
  reportedRouteFallback,
  resolveServerProxy,
  serverRouteFallback,
  setServerRouteFallback,
  setWorkerProxy,
} from "../dist/platform/server-link/server-proxy.js";
import { ServerRouteSupervisor } from "../dist/platform/server-link/server-route.js";

const server = "https://foundry.example";

function supervisor(clock, extra = {}) {
  const lines = [];
  const route = new ServerRouteSupervisor({
    serverURL: server,
    minFailures: 3,
    minFailingMs: 60_000,
    probeIntervalMs: 1000,
    now: () => clock.now,
    log: (line) => lines.push(line),
    env: {},
    ...extra,
  });
  return { route, lines };
}

test("a configured proxy that keeps failing is gone around, loudly, and only for a while", async (t) => {
  t.after(() => {
    setServerRouteFallback(undefined);
    clearWorkerProxy();
  });
  setWorkerProxy("http://user:secret@127.0.0.1:9");
  const clock = { now: 1_000_000 };
  const { route, lines } = supervisor(clock);
  let changes = 0;
  const stop = onServerRouteChange(() => changes++);
  t.after(stop);

  // Few failures, or failures in a short time, change nothing.
  route.attemptEnded(false);
  route.attemptEnded(false);
  clock.now += 61_000;
  assert.equal(serverRouteFallback(), undefined);
  route.attemptEnded(false);
  const fallback = serverRouteFallback();
  assert.equal(fallback?.route, "direct");
  assert.equal(resolveServerProxy(server).url, undefined);
  assert.equal(resolveServerProxy(server).source, "fallback direct");
  assert.equal(changes, 1);
  assert.match(
    lines.at(-1),
    /WORKER PROXY UNREACHABLE: 3 connection attempts through http:\/\/127\.0\.0\.1:9 failed over 61s\. Connecting directly/,
  );
  const reported = reportedRouteFallback();
  assert.equal(reported.configured, "http://127.0.0.1:9");
  assert.equal(JSON.stringify(reported).includes("secret"), false);

  // The direct route that works stays; a blip on it is retried.
  route.attemptEnded(true);
  route.attemptEnded(false);
  assert.equal(serverRouteFallback()?.route, "direct");

  // Back to the proxy once it accepts connections.
  const probed = [];
  const back = supervisor(clock, {
    probe: async (host, port) => {
      probed.push(`${host}:${port}`);
    },
  });
  clock.now += 2000;
  await back.route.checkConfigured();
  assert.deepEqual(probed, ["127.0.0.1:9"]);
  assert.equal(serverRouteFallback(), undefined);
  assert.equal(
    resolveServerProxy(server).url,
    "http://user:secret@127.0.0.1:9/",
  );
  assert.match(back.lines.at(-1), /accepts connections again/);
});

test("the environment's proxy comes before direct, and nothing is tried forever", (t) => {
  t.after(() => {
    setServerRouteFallback(undefined);
    clearWorkerProxy();
  });
  setWorkerProxy("http://127.0.0.1:9");
  const clock = { now: 5_000_000 };
  const env = { HTTPS_PROXY: "http://corp-proxy:3128" };
  const { route, lines } = supervisor(clock, { env });
  for (let i = 0; i < 3; i++) {
    route.attemptEnded(false);
    clock.now += 30_000;
  }
  assert.equal(serverRouteFallback()?.route, "environment");
  assert.equal(resolveServerProxy(server, env).url, "http://corp-proxy:3128/");
  for (let i = 0; i < 3; i++) route.attemptEnded(false);
  assert.equal(serverRouteFallback()?.route, "direct");
  for (let i = 0; i < 3; i++) route.attemptEnded(false);
  assert.equal(serverRouteFallback(), undefined);
  assert.match(
    lines.at(-1),
    /No route around the Worker proxy .* trying it again/,
  );
});

test("a changed proxy configuration ends the detour", (t) => {
  t.after(() => {
    setServerRouteFallback(undefined);
    clearWorkerProxy();
  });
  setWorkerProxy("http://127.0.0.1:9");
  const clock = { now: 9_000_000 };
  const { route, lines } = supervisor(clock);
  for (let i = 0; i < 3; i++) {
    route.attemptEnded(false);
    clock.now += 30_000;
  }
  assert.equal(serverRouteFallback()?.route, "direct");
  setWorkerProxy("http://127.0.0.1:10");
  // A detour for another proxy does not apply to this one.
  assert.equal(resolveServerProxy(server).url, "http://127.0.0.1:10/");
  route.attemptEnded(false);
  assert.equal(serverRouteFallback(), undefined);
  assert.match(
    lines.join("\n"),
    /configuration changed; no longer going around/,
  );
});
