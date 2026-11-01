import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocketServer } from "ws";

const cli = resolve(import.meta.dirname, "../dist/cli.js");

// A service installed before devices started without a workspace passes its
// folder (~/Foundry) on every start. Once the person removed that workspace,
// the worker reported it again at each start and the server re-created it.
test("a daemon whose service names a folder the person removed starts as the device alone", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "foundry-daemon-removed-"));
  const stateRoot = join(root, "state");
  const workspace = join(root, "Foundry");
  mkdirSync(stateRoot);
  mkdirSync(workspace);
  const env = {
    ...process.env,
    FOUNDRY_STATE_ROOT: stateRoot,
    FOUNDRY_STACK: "",
  };
  const init = spawnSync(process.execPath, [cli, "init", workspace], {
    env,
    encoding: "utf8",
  });
  assert.equal(init.status, 0, init.stderr);
  const { id } = JSON.parse(
    readFileSync(join(workspace, ".foundry", "workspace.json"), "utf8"),
  );
  // What forget_workspace leaves behind: the folder is out of the registry
  // and recorded as removed. The folder itself stays.
  writeFileSync(join(stateRoot, "workspaces.json"), "[]");
  writeFileSync(
    join(stateRoot, "forgotten-workspaces.json"),
    JSON.stringify([
      { id, path: workspace, forgottenAt: "2026-10-09T11:46:40.000Z" },
    ]),
  );

  const requests = [];
  const registrations = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const path = request.url.split("?")[0];
    requests.push(`${request.method} ${path}`);
    if (path === "/api/daemon/register") {
      registrations.push(JSON.parse(body));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "registered" }));
      return;
    }
    // The removed workspace no longer exists on the server.
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });
  const sockets = new WebSocketServer({ noServer: true });
  let hello;
  server.on("upgrade", (request, socket, head) =>
    sockets.handleUpgrade(request, socket, head, (connection) =>
      connection.on("message", (raw) => {
        const envelope = JSON.parse(String(raw));
        if (envelope.type !== "hello" || hello) return;
        hello = envelope.payload;
        connection.send(
          JSON.stringify({ id: envelope.id, type: "registered" }),
        );
      }),
    ),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const serverURL = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(
    join(stateRoot, "daemon-config.json"),
    JSON.stringify({
      pairedAt: new Date().toISOString(),
      deviceCredential: "test-credential",
      serverURL,
      workspacePath: workspace,
    }),
  );

  const daemon = spawn(
    process.execPath,
    [cli, "daemon", "--server", serverURL, "--workspace", workspace],
    { env, stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  daemon.stderr.on("data", (chunk) => (stderr += chunk));
  t.after(() => {
    daemon.kill("SIGKILL");
    sockets.close();
    server.close();
  });
  const deadline = Date.now() + 15_000;
  while (!hello && daemon.exitCode === null && Date.now() < deadline)
    await new Promise((settle) => setTimeout(settle, 50));
  assert.ok(hello, `the daemon never said hello: ${stderr}`);
  assert.equal(daemon.exitCode, null, stderr);
  assert.equal(registrations.length, 1, requests.join(", "));
  assert.equal(registrations[0].workspace, undefined);
  assert.equal(hello.workspace, undefined);
  assert.deepEqual(hello.servedWorkspaceIds, []);
  // The next service install no longer passes the folder.
  const config = JSON.parse(
    readFileSync(join(stateRoot, "daemon-config.json"), "utf8"),
  );
  assert.equal(config.workspacePath, "");
  assert.deepEqual(
    JSON.parse(readFileSync(join(stateRoot, "workspaces.json"), "utf8")),
    [],
  );
});
