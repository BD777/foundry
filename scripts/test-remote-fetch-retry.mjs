#!/usr/bin/env node
// Device-error replies are not the same as a cut result: retry them instead of
// switching remote-fetch to tiny pieces and failing.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = await mkdtemp(path.join(tmpdir(), "remote-fetch-retry-"));
let calls = 0;
const server = http.createServer((req, res) => {
  calls++;
  res.setHeader("Content-Type", "application/json");
  if (calls <= 2) {
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: calls,
        result: {
          content: [
            {
              type: "text",
              text: "device_error: device did not answer a ping",
            },
          ],
        },
      }),
    );
    return;
  }
  const text = JSON.stringify({
    path: "jobs/file",
    size: 5,
    offset: 0,
    length: 5,
    truncated: false,
    data: Buffer.from("hello").toString("base64"),
  });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id: calls,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({ results: [{ ok: true, text }] }),
          },
        ],
      },
    }),
  );
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const { port } = server.address();
const out = path.join(tmp, "file");

try {
  const child = spawn(
    process.execPath,
    [
      path.join(import.meta.dirname, "lib", "remote-fetch.mjs"),
      "lease_test",
      "scratch",
      "jobs/file",
      out,
    ],
    {
      env: {
        ...process.env,
        FOUNDRY_SERVER_URL: `http://127.0.0.1:${port}`,
        FOUNDRY_LEASE_TOKEN: "test",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const status = await new Promise((done) => child.on("exit", done));
  assert.equal(status, 0, stderr);
  assert.equal(await readFile(out, "utf8"), "hello");
  assert.ok(calls >= 3, `expected retries, saw ${calls} calls`);
  console.log(`remote-fetch-retry: PASS (${calls} calls)`);
} finally {
  server.close();
  await rm(tmp, { recursive: true, force: true });
}
