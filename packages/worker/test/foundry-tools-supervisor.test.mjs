import assert from "node:assert/strict";
import test from "node:test";

const {
  FoundryToolsSupervisor,
  claudeFoundryToolsConnection,
  codexFoundryToolsConnection,
  foundryToolsRetryDelayMs,
  reconnectRegisteredFoundryTools,
} = await import("../dist/session/runner/foundry-tools-supervisor.js");

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("the retry schedule is capped at one minute and includes jitter", () => {
  const middle = () => 0.5;
  assert.deepEqual(
    [0, 1, 2, 3, 4, 9].map((attempt) =>
      foundryToolsRetryDelayMs(attempt, middle),
    ),
    [2_000, 5_000, 15_000, 30_000, 60_000, 60_000],
  );
  assert.ok(foundryToolsRetryDelayMs(0, () => 0.1) < 2_000);
  assert.equal(
    foundryToolsRetryDelayMs(9, () => 1),
    60_000,
  );
});

test("a failed connection backs off, retries and reports each transition once", async () => {
  const events = [];
  let attempts = 0;
  let status = "failed";
  const query = {
    mcpServerStatus: async () => [{ name: "foundry", status }],
    reconnectMcpServer: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("still offline");
      status = "connected";
    },
  };
  const supervisor = new FoundryToolsSupervisor(
    claudeFoundryToolsConnection(query),
    (...event) => events.push(event),
    () => 0.5,
    () => 5,
  );

  await supervisor.failed("initial timeout");
  await supervisor.failed("another failed check");
  await waitFor(() => attempts === 2 && status === "connected");
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(attempts, 2);
  assert.deepEqual(
    events.map(([label, detail, level]) => [label, detail, level]),
    [
      ["Foundry tools unavailable", "initial timeout", "warning"],
      [
        "Foundry tools reconnected",
        "The Foundry MCP connection recovered.",
        undefined,
      ],
    ],
  );
  supervisor.close();
});

test("closing the process stops retries already in flight", async () => {
  const events = [];
  let attempts = 0;
  let release;
  const query = {
    mcpServerStatus: async () => [{ name: "foundry", status: "failed" }],
    reconnectMcpServer: () => {
      attempts += 1;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  };
  const supervisor = new FoundryToolsSupervisor(
    claudeFoundryToolsConnection(query),
    (...event) => events.push(event),
    () => 0.5,
    () => 1,
  );

  await supervisor.failed("connect failed");
  await waitFor(() => attempts === 1);
  supervisor.close();
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(attempts, 1);
  assert.deepEqual(events, [
    ["Foundry tools unavailable", "connect failed", "warning"],
  ]);
});

test("a daemon reconnect reconnects failed tools without disturbing connected ones", async () => {
  let connectedReconnects = 0;
  const connected = new FoundryToolsSupervisor(
    claudeFoundryToolsConnection({
      mcpServerStatus: async () => [{ name: "foundry", status: "connected" }],
      reconnectMcpServer: async () => {
        connectedReconnects += 1;
      },
    }),
    () => {},
    () => 0.5,
    () => 60_000,
  );
  let failedStatus = "failed";
  let failedReconnects = 0;
  const failed = new FoundryToolsSupervisor(
    claudeFoundryToolsConnection({
      mcpServerStatus: async () => [{ name: "foundry", status: failedStatus }],
      reconnectMcpServer: async () => {
        failedReconnects += 1;
        failedStatus = "connected";
      },
    }),
    () => {},
    () => 0.5,
    () => 60_000,
  );

  await reconnectRegisteredFoundryTools();
  assert.equal(connectedReconnects, 0);
  assert.equal(failedReconnects, 1);
  connected.close();
  failed.close();
});

test("the daemon forwards the reconnect to the execution host when present", async () => {
  const { requestFoundryToolsReconnect } =
    await import("../dist/daemon/handlers/connection.js");
  const calls = [];
  await requestFoundryToolsReconnect(
    {
      serverReconnected: async () => {
        calls.push("host");
      },
    },
    async () => {
      calls.push("local");
    },
  );
  await requestFoundryToolsReconnect(undefined, async () => {
    calls.push("local");
  });
  assert.deepEqual(calls, ["host", "local"]);
});

test("the Codex adapter reads thread status and reloads the MCP servers", async () => {
  const calls = [];
  let runtimeStatus = "failed";
  const connection = codexFoundryToolsConnection(
    {
      request: async (method, params) => {
        calls.push([method, params]);
        if (method === "config/mcpServer/reload") {
          runtimeStatus = "connected";
          return {};
        }
        return {
          data: [{ name: "foundry", runtimeStatus, authStatus: "bearerToken" }],
        };
      },
    },
    "native-thread",
  );

  assert.equal(await connection.status(), "failed");
  await connection.reconnect();
  assert.equal(await connection.status(), "connected");
  assert.deepEqual(calls, [
    [
      "mcpServerStatus/list",
      {
        threadId: "native-thread",
        serverName: "foundry",
        detail: "toolsAndAuthOnly",
      },
    ],
    ["config/mcpServer/reload", null],
    [
      "mcpServerStatus/list",
      {
        threadId: "native-thread",
        serverName: "foundry",
        detail: "toolsAndAuthOnly",
      },
    ],
    [
      "mcpServerStatus/list",
      {
        threadId: "native-thread",
        serverName: "foundry",
        detail: "toolsAndAuthOnly",
      },
    ],
  ]);
});
