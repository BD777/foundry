// A connector-provided model profile (Limen's limen_default) for the eval's
// sandboxed assistant worker. The connector's session helper must run outside
// the sandbox: it checks that its local adapter is alive by process id, and
// the sandbox has its own process view (--unshare-pid). The worker gets a
// device profile with the same id, label, models and identity whose helper is
// a small shim; the shim relays its stdin and stdout over a unix socket in the
// run folder to the real helper, which the harness starts outside the
// sandbox with the worker's basic variables. The helper writes its files
// into the configuration folder named in the request, which is under the run
// folder at the same path inside and outside. The helper's stderr is not
// relayed (it may carry credentials); the harness logs only its error code.

import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const hostProviders = () =>
  process.env.PA_EVAL_HOST_MODEL_PROVIDERS ||
  resolve(homedir(), ".foundry/extension-model-providers.json");

/** The connector-provided profile with this id on this computer, if any. */
export function hostConnectorProfile(id) {
  const path = hostProviders();
  if (!id || !existsSync(path)) return undefined;
  const providers = JSON.parse(readFileSync(path, "utf8")).providers ?? [];
  const found = providers.find((p) => p.id === id && !p.problem);
  if (!found?.externalConnection?.executable) return undefined;
  return found;
}

const shimSource = (socket) => `#!/usr/bin/env node
const net = require("node:net");
const env = Object.fromEntries(
  ["PATH", "HOME", "USER", "LOGNAME", "LANG", "TZ"]
    .filter((k) => process.env[k] !== undefined)
    .map((k) => [k, process.env[k]]),
);
const socket = net.connect(${JSON.stringify(socket)});
socket.on("connect", () => {
  socket.write(JSON.stringify({ env }) + "\\n");
  process.stdin.pipe(socket);
});
socket.pipe(process.stdout);
socket.on("error", () => process.exit(1));
socket.on("close", () => process.exit(0));
process.on("SIGTERM", () => { socket.destroy(); process.exit(0); });
process.on("SIGINT", () => { socket.destroy(); process.exit(0); });
`;

/**
 * Starts the relay for one provider: returns the device profile for the
 * worker's agent-profiles.local.json and a stop function.
 */
export function startConnectionRelay(provider, runDir, log = () => {}) {
  const socketPath = resolve(runDir, "connection-relay.sock");
  const shimPath = resolve(runDir, "connection-relay-shim.cjs");
  rmSync(socketPath, { force: true });
  writeFileSync(shimPath, shimSource(socketPath), { mode: 0o700 });
  chmodSync(shimPath, 0o700);
  const { executable, args = [] } = provider.externalConnection;
  const children = new Set();
  let served = 0;
  // Half-open: the shim's end of input is the helper's end of stdin (its
  // release); the socket closes once the helper has exited.
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let header = Buffer.alloc(0);
    let child;
    const onHeader = (chunk) => {
      header = Buffer.concat([header, chunk]);
      const newline = header.indexOf(10);
      if (newline < 0) {
        if (header.length > 16384) socket.destroy();
        return;
      }
      socket.removeListener("data", onHeader);
      let env = {};
      try {
        env = JSON.parse(header.subarray(0, newline).toString("utf8")).env;
      } catch {
        socket.destroy();
        return;
      }
      const rest = header.subarray(newline + 1);
      const directory = mkdtempSync(join(tmpdir(), "pa-eval-connection-"));
      child = spawn(executable, args, {
        cwd: directory,
        env: { ...env, TMPDIR: directory },
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.add(child);
      served++;
      let stderrTail = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (c) => {
        stderrTail = (stderrTail + c).slice(-4096);
      });
      child.stdout.pipe(socket);
      if (rest.length) child.stdin.write(rest);
      socket.pipe(child.stdin);
      child.stdin.on("error", () => {});
      child.on("close", (status) => {
        children.delete(child);
        rmSync(directory, { recursive: true, force: true });
        const line = stderrTail.trimEnd().split("\n").pop() ?? "";
        const code = /\(([a-z]+(?:_[a-z]+){0,7})\)\.?$/.exec(line)?.[1];
        if (code || status) log(`connection helper ended: ${code || status}`);
        socket.end();
      });
    };
    socket.on("data", onHeader);
    socket.on("error", () => {});
    socket.on("close", () => {
      if (child && child.exitCode === null) child.kill("SIGTERM");
    });
  });
  server.listen(socketPath);
  const profile = {
    id: provider.id,
    label: provider.label,
    runtime: provider.runtime,
    connectionType: "external",
    model: provider.model,
    models: provider.models,
    externalConnection: {
      executable: shimPath,
      args: [],
      identity: provider.externalConnection.identity,
    },
  };
  return {
    profile,
    served: () => served,
    stop() {
      for (const child of children) child.kill("SIGTERM");
      server.close();
      rmSync(socketPath, { force: true });
    },
  };
}
