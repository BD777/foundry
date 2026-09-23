import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = resolve(import.meta.dirname, "../dist/cli.js");

test("a paired daemon registers its workspace before reading it back", async () => {
  const root = mkdtempSync(join(tmpdir(), "foundry-daemon-startup-"));
  const stateRoot = join(root, "state");
  const workspace = join(root, "workspace");
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

  // The server only answers for workspaces it knows, like the real one.
  const requests = [];
  let registered = false;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request);
    const path = request.url.split("?")[0];
    requests.push(`${request.method} ${path}`);
    let status = 404;
    let payload = { error: "not found" };
    if (path === "/api/daemon/register") {
      registered = true;
      status = 200;
      payload = {
        id: "dev_startup",
        label: "Startup",
        status: "connected",
        lastSeenLabel: "now",
      };
    } else if (path === "/api/issues" && registered) {
      status = 200;
      payload = [];
    }
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(payload));
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
  try {
    const deadline = Date.now() + 15_000;
    while (
      !requests.includes("GET /api/issues") &&
      daemon.exitCode === null &&
      Date.now() < deadline
    )
      await new Promise((settle) => setTimeout(settle, 50));
    const register = requests.indexOf("POST /api/daemon/register");
    const read = requests.indexOf("GET /api/issues");
    assert.ok(read >= 0, `daemon never read its issues: ${stderr}`);
    assert.ok(
      register >= 0 && register < read,
      `register must precede the first read: ${requests.join(", ")}`,
    );
    assert.doesNotMatch(stderr, /returned 404/);
  } finally {
    daemon.kill("SIGKILL");
    server.close();
  }
});
