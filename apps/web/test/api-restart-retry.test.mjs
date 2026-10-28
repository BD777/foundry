import assert from "node:assert/strict";
import test from "node:test";
import { fetchThroughRestart, serverStartingHeader } from "../src/api/http.ts";

const proxyError = (status) =>
  new Response("<html><body>Bad Gateway</body></html>", {
    status,
    headers: { "Content-Type": "text/html" },
  });
const starting = () =>
  new Response("the Foundry server is starting", {
    status: 503,
    headers: { [serverStartingHeader]: "1", "Retry-After": "2" },
  });

function withFetch(answers, run) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    const answer = answers[Math.min(calls++, answers.length - 1)];
    if (answer instanceof Error) throw answer;
    return typeof answer === "function"
      ? answer()
      : new Response("", { status: answer });
  };
  return run(() => calls).finally(() => {
    globalThis.fetch = original;
  });
}

const waits = [];
const noWait = async (ms) => {
  waits.push(ms);
};

test("a read that reached no server during a restart is sent again until it is answered", () =>
  withFetch(
    [() => proxyError(502), starting, () => proxyError(504), 200],
    async (calls) => {
      waits.length = 0;
      const response = await fetchThroughRestart(
        "/api/x",
        {},
        [1, 2, 3, 4],
        noWait,
      );
      assert.equal(response.status, 200);
      assert.equal(calls(), 4);
      assert.deepEqual(waits, [1, 2, 3]);
    },
  ));

test("the proxy's last answer is kept once the retries run out", () =>
  withFetch([() => proxyError(502)], async (calls) => {
    const response = await fetchThroughRestart("/api/x", {}, [1, 1], noWait);
    assert.equal(response.status, 502);
    assert.equal(calls(), 3);
  }));

test("the API's own errors and busy answers are returned at once", async () => {
  for (const answer of [
    500,
    409,
    // The API's 502–504: a device that timed out, a lost response.
    () =>
      new Response(JSON.stringify({ error: "server unreachable" }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      }),
    () => new Response("slow", { status: 504 }),
    // database_busy, device busy: 503 with Retry-After but not starting.
    () =>
      new Response(JSON.stringify({ code: "database_busy" }), {
        status: 503,
        headers: { "Retry-After": "2" },
      }),
  ]) {
    await withFetch([answer], async (calls) => {
      await fetchThroughRestart("/api/x", {}, [1, 1], noWait);
      assert.equal(calls(), 1);
    });
  }
});

test("a failed connection (the browser is offline) fails at once", () =>
  withFetch([new TypeError("Failed to fetch")], async (calls) => {
    await assert.rejects(
      fetchThroughRestart("/api/x", {}, [1, 1], noWait),
      TypeError,
    );
    assert.equal(calls(), 1);
  }));

test("a read aborted while it waits is not sent again", () =>
  withFetch([() => proxyError(502)], async (calls) => {
    const controller = new AbortController();
    await assert.rejects(
      fetchThroughRestart(
        "/api/x",
        { signal: controller.signal },
        [1, 1],
        async () => controller.abort(),
      ),
    );
    assert.equal(calls(), 1);
  }));
