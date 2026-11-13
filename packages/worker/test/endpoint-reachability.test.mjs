import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import {
  assertEndpointReachable,
  directEndpoint,
} from "../dist/session/runner/endpoint-reachability.js";
import { connectTcp } from "../dist/platform/tcp-connect.js";

test("directEndpoint reads host and default port of the base URL", () => {
  assert.deepEqual(
    directEndpoint({ ANTHROPIC_BASE_URL: "http://10.0.0.1/g9baf" }),
    { host: "10.0.0.1", port: 80 },
  );
  assert.deepEqual(
    directEndpoint({ ANTHROPIC_BASE_URL: "https://gw.example:8443/x" }),
    { host: "gw.example", port: 8443 },
  );
  assert.deepEqual(directEndpoint({ ANTHROPIC_BASE_URL: "https://a.test" }), {
    host: "a.test",
    port: 443,
  });
});

test("nothing is probed without an endpoint, with a proxy, or for a bad URL", async () => {
  const failing = async () => {
    throw new Error("must not connect");
  };
  await assertEndpointReachable({}, failing);
  await assertEndpointReachable(
    { ANTHROPIC_BASE_URL: "http://10.0.0.1", HTTPS_PROXY: "http://p:1" },
    failing,
  );
  await assertEndpointReachable({ ANTHROPIC_BASE_URL: "not a url" }, failing);
});

test("an unreachable endpoint fails with the address and the reason", async () => {
  await assert.rejects(
    assertEndpointReachable(
      { ANTHROPIC_BASE_URL: "http://10.251.248.226/g9" },
      async () => {
        throw new Error("no answer within 10s");
      },
    ),
    /10\.251\.248\.226:80 is not reachable from this device \(no answer within 10s\)/,
  );
});

test("connectTcp succeeds against a listening port and fails on a closed one", async () => {
  const server = createServer((socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await connectTcp("127.0.0.1", port, 2000);
  await new Promise((resolve) => server.close(resolve));
  await assert.rejects(connectTcp("127.0.0.1", port, 2000));
});
