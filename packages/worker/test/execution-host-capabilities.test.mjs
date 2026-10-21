import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { processIdentity } from "../dist/agent-processes.js";
import { ExecutionHostClient } from "../dist/execution-host/client.js";
import { availableDaemonCapabilities } from "../dist/workspace-ops.js";

test("draft capability follows the connected execution host across an upgrade", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "host-cap-"));
  const path = join(root, "host.sock");
  let capabilities = ["idle_upgrade", "session_work"];
  const snapshot = () => ({
    protocol: 1,
    pid: process.pid,
    startTime: processIdentity(process.pid).startTime,
    capabilities,
    busy: true,
    claims: [{ sessionId: "still-running", inputId: "input" }],
    background: [],
  });
  const server = createServer((socket) => {
    createInterface({ input: socket }).on("line", (line) => {
      const request = JSON.parse(line);
      socket.write(
        JSON.stringify({ id: request.id, result: snapshot() }) + "\n",
      );
    });
  });
  const client = new ExecutionHostClient(path, "synthetic-token");
  t.after(async () => {
    client.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  await new Promise((resolve) => server.listen(path, resolve));
  const advertisesDrafts = () =>
    availableDaemonCapabilities(client).includes("workspace_draft_skills_v1");
  assert.equal(
    advertisesDrafts(),
    false,
    "an unknown host cannot promise drafts",
  );
  await client.open();
  assert.equal(client.owns("still-running", "input"), true);
  assert.equal(
    advertisesDrafts(),
    false,
    "a busy older host retains its limits",
  );
  assert.ok(availableDaemonCapabilities(client).includes("worker_update"));
  assert.equal(
    availableDaemonCapabilities(client).includes("exact_input_cancel_v1"),
    false,
  );
  capabilities = [
    ...capabilities,
    "workspace_draft_skills_v1",
    "exact_input_cancel_v1",
  ];
  await client.refresh();
  assert.equal(
    advertisesDrafts(),
    true,
    "a new host can enable the capability",
  );
  assert.equal(
    availableDaemonCapabilities(client).includes("exact_input_cancel_v1"),
    true,
  );
  client.close();
  assert.equal(
    advertisesDrafts(),
    false,
    "a stale snapshot cannot promise support",
  );
  assert.ok(
    availableDaemonCapabilities().includes("workspace_draft_skills_v1"),
    "a daemon executing locally uses its own implementation",
  );
});
