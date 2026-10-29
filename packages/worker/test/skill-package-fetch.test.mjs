import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { packZip } from "../dist/skill-zip.js";
import { materializeSessionSkills } from "../dist/skill-materializer.js";
import { fetchSkillPackage } from "../dist/skill-package-fetch.js";
import { foundryStatePath } from "../dist/state-root.js";
import { Agent } from "undici";

// Server requests go through the Worker's own undici fetch (serverFetch), not
// the global one, so these tests answer them at that undici's direct Agent:
// `respond(url, { signal })` returns a Response or throws, as a fetch stub
// would. Errors reach the caller as undici's TypeError("fetch failed") with
// the thrown value as its cause; canceling the request aborts `signal`.
function answerServerRequests(t, respond) {
  t.mock.method(Agent.prototype, "dispatch", function (options, handler) {
    const controller = new AbortController();
    handler.onConnect((reason) => {
      if (controller.signal.aborted) return;
      controller.abort(reason ?? new DOMException("aborted", "AbortError"));
      handler.onError(controller.signal.reason);
    });
    const url = new URL(options.path, options.origin).href;
    Promise.resolve()
      .then(() => respond(url, { signal: controller.signal }))
      .then(async (response) => {
        const body = Buffer.from(await response.arrayBuffer());
        if (controller.signal.aborted) return;
        const raw = [];
        response.headers.forEach((value, name) =>
          raw.push(Buffer.from(name), Buffer.from(value)),
        );
        handler.onHeaders(response.status, raw, () => {}, response.statusText);
        if (body.length) handler.onData(body);
        handler.onComplete([]);
      })
      .catch((error) => {
        if (!controller.signal.aborted) handler.onError(error);
      });
    return true;
  });
}

function fixture(name = "fixture") {
  const id = `${name}-${randomUUID()}`;
  const bytes = packZip([
    {
      path: "SKILL.md",
      data: Buffer.from(`---\nname: ${id}\n---\nSynthetic test ${id}\n`),
    },
  ]);
  const ref = {
    skillId: `skill-${id}`,
    name: id,
    revision: 7,
    checksum: createHash("sha256").update(bytes).digest("hex"),
    byteSize: bytes.length,
  };
  return {
    ref,
    bytes,
    archive: foundryStatePath("skill-archives", `${ref.checksum}.zip`),
  };
}
const networkError = () =>
  new TypeError("fetch failed; Authorization: Bearer do-not-log-this-secret", {
    cause: Object.assign(new Error("private request data"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
    }),
  });
const tick = () => new Promise((resolve) => setImmediate(resolve));
function pendingFetch(signal, state) {
  state.pending++;
  return new Promise((resolve, reject) => {
    signal.addEventListener(
      "abort",
      () => {
        state.pending--;
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

test("cold fixed-revision package retries one connection failure, then hot cache needs no request", async (t) => {
  const { ref, bytes } = fixture();
  let calls = 0;
  const notices = [];
  answerServerRequests(t, async () => {
    if (++calls === 1) throw networkError();
    return new Response(bytes);
  });
  const first = await materializeSessionSkills(
    [ref],
    "https://foundry.invalid",
    "/tmp",
    { onRetry: (m) => notices.push(m) },
  );
  assert.equal(calls, 2);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /UND_ERR_CONNECT_TIMEOUT/);
  assert.doesNotMatch(notices[0], /do-not-log/);
  const second = await materializeSessionSkills(
    [ref],
    "https://foundry.invalid",
    "/tmp",
  );
  assert.equal(calls, 2);
  assert.equal(first.snapshotDigest, second.snapshotDigest);
});

test("persistent connection failure aborts and settles peers without dispatching more packages", async (t) => {
  const items = Array.from({ length: 16 }, (_, i) =>
    fixture(`a${String(i).padStart(2, "0")}`),
  );
  const state = { pending: 0 };
  const calls = [];
  const failure = networkError();
  answerServerRequests(t, async (url, { signal }) => {
    calls.push(String(url));
    if (String(url).includes(items[0].ref.skillId)) throw failure;
    return pendingFetch(signal, state);
  });
  await assert.rejects(
    materializeSessionSkills(
      items.map((x) => x.ref),
      "https://foundry.invalid",
      "/tmp",
      { onRetry: () => {} },
    ),
    (error) => {
      assert.equal(error.cause.cause, failure);
      assert.match(error.message, /attempt 2\/2.*UND_ERR_CONNECT_TIMEOUT/);
      return true;
    },
  );
  assert.equal(calls.length, 9);
  assert.equal(state.pending, 0);
  assert.ok(!calls.some((url) => url.includes(items[8].ref.skillId)));
});

test("canceling preparation aborts in-flight downloads, does not retry or launch more", async (t) => {
  const items = Array.from({ length: 12 }, () => fixture());
  const controller = new AbortController();
  const state = { pending: 0 };
  let calls = 0;
  answerServerRequests(t, async (_url, { signal }) => {
    calls++;
    return pendingFetch(signal, state);
  });
  const running = materializeSessionSkills(
    items.map((x) => x.ref),
    "https://foundry.invalid",
    "/tmp",
    { signal: controller.signal },
  );
  await tick();
  assert.equal(state.pending, 8);
  controller.abort();
  await assert.rejects(running, (error) => error.name === "AbortError");
  assert.equal(calls, 8);
  assert.equal(state.pending, 0);
});

test("canceling one session cannot abort another session's download of the same archive", async (t) => {
  const { ref, bytes, archive } = fixture();
  const controller = new AbortController();
  let calls = 0;
  let finishOther, downloadSignal;
  answerServerRequests(t, async (_url, { signal }) => {
    calls++;
    downloadSignal = signal;
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
      finishOther = () => resolve(new Response(bytes));
    });
  });
  const first = materializeSessionSkills(
    [ref],
    "https://foundry.invalid",
    "/tmp",
    { signal: controller.signal },
  );
  await tick();
  const second = materializeSessionSkills(
    [ref],
    "https://foundry.invalid",
    "/tmp",
  );
  await tick();
  assert.equal(calls, 1);
  controller.abort();
  await assert.rejects(first);
  assert.equal(downloadSignal.aborted, false);
  finishOther();
  await second;
  assert.ok(readFileSync(archive).equals(bytes));
});

test("HTTP, abort, unknown fetch and integrity errors are not retried or cached", async (t) => {
  for (const mode of [
    "401",
    "403",
    "500",
    "abort",
    "unknown",
    "checksum",
    "size",
  ]) {
    await t.test(mode, async (t) => {
      const { ref, bytes, archive } = fixture();
      let calls = 0;
      answerServerRequests(t, async () => {
        calls++;
        if (mode === "abort")
          throw new DOMException("request canceled", "AbortError");
        if (mode === "unknown") throw new TypeError("fetch failed");
        if (/^\d/.test(mode))
          return new Response("must not expose this body", {
            status: Number(mode),
          });
        return new Response(
          mode === "checksum" ? Buffer.from("wrong bytes") : bytes,
        );
      });
      if (mode === "size") ref.byteSize++;
      await assert.rejects(
        materializeSessionSkills([ref], "https://foundry.invalid", "/tmp"),
      );
      assert.equal(calls, 1);
      assert.equal(existsSync(archive), false);
    });
  }
});

test("download diagnostics strip URL credentials and query while retaining the original cause", async (t) => {
  const { ref } = fixture();
  let requests = 0;
  answerServerRequests(t, async () => {
    requests++;
    throw new TypeError("fetch failed");
  });
  // undici refuses a URL with credentials before sending anything; the
  // diagnostic keeps that refusal as its cause and drops the secrets.
  await assert.rejects(
    fetchSkillPackage(
      "https://person:password@foundry.invalid?token=querysecret",
      ref,
    ),
    (error) => {
      assert.equal(requests, 0);
      assert.ok(error.cause instanceof TypeError);
      assert.match(error.cause.message, /credentials/);
      assert.match(error.message, new RegExp(ref.skillId));
      assert.match(error.message, /revision 7/);
      assert.doesNotMatch(error.message, /person|password|querysecret/);
      return true;
    },
  );
});

test("real HTTP socket loss retries the immutable GET once and verifies its bytes", async (t) => {
  const { createServer } = await import("node:http");
  const { ref, bytes } = fixture();
  let requests = 0;
  const server = createServer((request, response) => {
    assert.equal(request.method, "GET");
    assert.equal(
      request.url,
      `/api/skills/catalog/${ref.skillId}/revisions/7/package`,
    );
    if (++requests === 1) {
      request.socket.destroy();
      return;
    }
    response.end(bytes);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const notices = [];
  await materializeSessionSkills(
    [ref],
    `http://127.0.0.1:${server.address().port}`,
    "/tmp",
    { onRetry: (m) => notices.push(m) },
  );
  assert.equal(requests, 2);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /UND_ERR_SOCKET|ECONNRESET/);
});

test(
  "a session canceled during Skill download never reaches its native runtime",
  { timeout: 10000 },
  async (t) => {
    const { executeAgentSession } =
      await import("../dist/daemon/session-execution.js");
    const { cancelActiveSession } = await import("../dist/session-control.js");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "skill-cancel-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const { ref } = fixture();
    const state = { pending: 0 };
    let started;
    const entered = new Promise((resolve) => {
      started = resolve;
    });
    answerServerRequests(t, async (_url, { signal }) => {
      started();
      return pendingFetch(signal, state);
    });
    const sent = [];
    const session = {
      id: `sess_${randomUUID()}`,
      provider: "codex",
      profileId: "codex_local",
      workspaceId: "ws",
      source: "chat",
      model: "gpt-6-astra",
      input: { id: "input", prompt: "synthetic never executed" },
      skillRefs: [ref],
    };
    const running = executeAgentSession(
      { send: (type, payload) => sent.push({ type, payload }) },
      { cwd: root, stateRoot: root },
      session,
      undefined,
      { id: "codex_local", runtime: "codex", connectionType: "local_login" },
      {
        serverURL: "https://foundry.invalid",
        sessionToken: "",
        workspaceID: "ws",
      },
    );
    await entered;
    await cancelActiveSession(session.id, "input");
    await running;
    assert.equal(state.pending, 0);
    assert.ok(sent.some((x) => x.payload?.event?.label === "Session canceled"));
    assert.ok(
      !sent.some((x) =>
        /Started Codex|Loaded skills/.test(x.payload?.event?.label ?? ""),
      ),
    );
    assert.equal(
      existsSync(
        join(root, ".foundry", "sessions", session.id, "inputs", "input"),
      ),
      false,
    );
  },
);

test(
  "cancel interrupts a real response body that never finishes",
  { timeout: 4000 },
  async (t) => {
    const { createServer } = await import("node:http");
    const { ref, bytes } = fixture();
    const controller = new AbortController();
    let opened, closed;
    let requests = 0;
    const bodyOpened = new Promise((resolve) => {
      opened = resolve;
    });
    const bodyClosed = new Promise((resolve) => {
      closed = resolve;
    });
    const server = createServer((_request, response) => {
      requests++;
      response.on("close", closed);
      response.writeHead(200);
      response.write(bytes.subarray(0, 12));
      opened();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const running = materializeSessionSkills(
      [ref],
      `http://127.0.0.1:${server.address().port}`,
      "/tmp",
      { signal: controller.signal },
    );
    await bodyOpened;
    await tick();
    controller.abort();
    await assert.rejects(running, (error) => error.name === "AbortError");
    await bodyClosed;
    assert.equal(requests, 1);
  },
);
