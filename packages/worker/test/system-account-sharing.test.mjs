import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The runner exports a scratch FOUNDRY_STATE_ROOT before anything loads.
const { pairWithConsent } = await import("../dist/pairing-consent.js");
const { setSystemAccountSharing, sharedSystemAccountNote } =
  await import("../dist/system-account-sharing.js");
const { sessionResourceNotes } = await import("../dist/resource-pool.js");

const refusal = {
  error:
    "This computer account is already used by Alice in Foundry. If you continue, you share it.",
  code: "system_account_shared",
  sharedWith: ["Alice"],
};

/** A pairing endpoint that answers by the request's body and count. */
async function pairingServer(answer) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body || "{}"));
    const [status, payload] = answer(requests.at(-1), requests.length);
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(payload));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => server.close(),
  };
}

function io({ answer } = {}) {
  const lines = [];
  return {
    lines,
    io: {
      ask: answer
        ? (_question, signal) =>
            new Promise((resolve, reject) => {
              const timer = setTimeout(() => resolve(answer), 30);
              signal.addEventListener("abort", () => {
                clearTimeout(timer);
                reject(new Error("aborted"));
              });
            })
        : undefined,
      log: (line) => lines.push(line),
      pollMs: 5,
      sleep: (ms, signal) =>
        new Promise((done) => {
          const timer = setTimeout(done, ms);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            done();
          });
        }),
    },
  };
}

test("the terminal is told plainly and continuing shares the account", async () => {
  const server = await pairingServer((body) =>
    body.acceptSharedAccount
      ? [201, { deviceId: "dev_b", credential: "cred" }]
      : [409, refusal],
  );
  const terminal = io({ answer: "y" });
  try {
    const paired = await pairWithConsent(
      server.url,
      "tok",
      {},
      {
        ...terminal.io,
        pollMs: 10_000,
      },
    );
    assert.equal(paired.credential, "cred");
    assert.ok(terminal.lines.some((line) => line === refusal.error));
    assert.equal(server.requests.at(-1).acceptSharedAccount, true);
  } finally {
    server.close();
  }
});

test("answering no pairs nothing", async () => {
  const server = await pairingServer(() => [409, refusal]);
  const terminal = io({ answer: "n" });
  try {
    await assert.rejects(
      pairWithConsent(
        server.url,
        "tok",
        {},
        { ...terminal.io, pollMs: 10_000 },
      ),
      /Pairing cancelled; nothing was paired/,
    );
    assert.ok(server.requests.every((body) => !body.acceptSharedAccount));
  } finally {
    server.close();
  }
});

test("without a terminal, Continue in the web completes the pairing", async () => {
  // The third request finds the web's choice recorded.
  const server = await pairingServer((_body, count) =>
    count >= 3
      ? [201, { deviceId: "dev_b", credential: "web" }]
      : [409, refusal],
  );
  const headless = io();
  try {
    const paired = await pairWithConsent(server.url, "tok", {}, headless.io);
    assert.equal(paired.credential, "web");
    assert.ok(
      headless.lines.some((line) => line.includes("--share-system-account")),
    );
    assert.ok(server.requests.every((body) => !body.acceptSharedAccount));
  } finally {
    server.close();
  }
});

test("Cancel in the web ends the wait", async () => {
  const server = await pairingServer((_body, count) =>
    count >= 2
      ? [401, { error: "this pairing was cancelled in the Foundry web app" }]
      : [409, refusal],
  );
  try {
    await assert.rejects(
      pairWithConsent(server.url, "tok", {}, io().io),
      /cancelled in the Foundry web app/,
    );
  } finally {
    server.close();
  }
});

test("--share-system-account continues without asking", async () => {
  const server = await pairingServer((body) =>
    body.acceptSharedAccount
      ? [201, { deviceId: "dev_b", credential: "flag" }]
      : [409, refusal],
  );
  try {
    const paired = await pairWithConsent(
      server.url,
      "tok",
      { shareSystemAccount: true },
      io().io,
    );
    assert.equal(paired.credential, "flag");
    assert.equal(server.requests.length, 1);
  } finally {
    server.close();
  }
});

test("sessions on a shared account are told it is not private", () => {
  setSystemAccountSharing({ sharedWith: [] });
  assert.equal(sharedSystemAccountNote(), "");
  assert.doesNotMatch(sessionResourceNotes("/tmp/ws", []), /shared/);

  setSystemAccountSharing({ sharedWith: ["Alice", " ", 7] });
  assert.match(sharedSystemAccountNote(), /Alice also uses it/);
  assert.match(sharedSystemAccountNote(), /do not assume privacy/);
  assert.match(
    sessionResourceNotes("/tmp/ws", []),
    /This computer account is shared: Alice also uses it/,
  );
  const stored = JSON.parse(
    readFileSync(
      join(process.env.FOUNDRY_STATE_ROOT, "system-account-sharing.json"),
      "utf8",
    ),
  );
  assert.deepEqual(stored, { sharedWith: ["Alice"] });
  setSystemAccountSharing({ sharedWith: [] });
});
