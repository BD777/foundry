// A connector-provided model profile (Limen's limen_default) for the eval's
// sandboxed assistant worker. The connector's session helper must run outside
// the sandbox: it checks that its local adapter is alive by process id, and
// the sandbox has its own process view (--unshare-pid). The worker gets a
// device profile with the same id, label, models and identity whose helper is
// a small shim; the shim relays its stdin and stdout over a unix socket in the
// run folder to the real helper, which the harness starts outside the
// sandbox with this computer's basic variables. The helper writes its files
// into the configuration folder named in the request, which is under the run
// folder at the same path inside and outside. The helper's stderr is not
// relayed (it may carry credentials); the harness logs only its error code.
//
// A sandbox with its own network (pa-eval-sandbox.mjs, `net`) cannot reach
// the helper's local adapter: the relay reads the helper's reply, bridges
// each loopback port its environment names (a proxy such as
// HTTPS_PROXY=http://127.0.0.1:PORT) into the sandbox at the same port, and
// passes the reply on unchanged once the bridge listens. Nothing of the
// reply is logged.

import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const hostProviders = () =>
  process.env.PA_EVAL_HOST_MODEL_PROVIDERS ||
  resolve(homedir(), ".foundry/extension-model-providers.json");

const hostBasics = () =>
  Object.fromEntries(
    ["PATH", "HOME", "USER", "LOGNAME", "LANG", "TZ"]
      .filter((k) => process.env[k] !== undefined)
      .map((k) => [k, process.env[k]]),
  );

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

// The loopback ports a helper's reply points the CLI at.
export function replyPorts(line) {
  let reply;
  try {
    reply = JSON.parse(line);
  } catch {
    return [];
  }
  const set = reply?.environment?.set || {};
  return [
    ...new Set(
      Object.values(set)
        .map(
          (v) =>
            /^[a-z]+:\/\/(?:[^@/\s]*@)?(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)\/?$/i.exec(
              String(v),
            )?.[1],
        )
        .filter(Boolean)
        .map(Number),
    ),
  ];
}

// The helper's output to the shim: the first line (the reply) once its
// ports are bridged, then the rest as it comes.
function relayReply(stdout, socket, net, log) {
  if (!net) {
    stdout.pipe(socket);
    return;
  }
  let head = Buffer.alloc(0);
  const onData = async (chunk) => {
    head = Buffer.concat([head, chunk]);
    const newline = head.indexOf(10);
    if (newline < 0 && head.length < 262144) return;
    stdout.removeListener("data", onData);
    stdout.pause();
    const line = head.subarray(0, newline < 0 ? head.length : newline);
    for (const port of replyPorts(line.toString("utf8"))) {
      net.forward(port);
      if (!(await net.ready(port)))
        log(`the sandbox's bridge did not take port ${port} in time`);
    }
    socket.write(head);
    stdout.pipe(socket);
    stdout.resume();
  };
  stdout.on("data", onData);
}

// A slot among PA_EVAL_HELPER_SLOTS shared by every process that names the
// same PA_EVAL_HELPER_SLOTS_DIR: a slot is a folder made atomically, holding
// its owner's pid; a slot whose owner is gone is taken back. Without the
// variables there is no limit. Resolves to the slot's release.
export async function helperSlot(
  dir = process.env.PA_EVAL_HELPER_SLOTS_DIR,
  slots = Number(process.env.PA_EVAL_HELPER_SLOTS || 0),
) {
  if (!dir || !slots) return () => {};
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code === "EPERM";
    }
  };
  // First come, first served: a waiter takes a free slot only when no
  // older waiter (a ticket of a live process) is still waiting, so a stack
  // that starts last is not starved by the others.
  const queue = join(dir, "queue");
  mkdirSync(queue, { recursive: true, mode: 0o700 });
  const ticket = `${String(Date.now()).padStart(15, "0")}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(join(queue, ticket), "");
  const first = () => {
    for (const name of readdirSync(queue).sort()) {
      if (name === ticket) return true;
      const owner = Number(name.split("-")[1]);
      if (owner && alive(owner)) return false;
      rmSync(join(queue, name), { force: true });
    }
    return true;
  };
  for (;;) {
    if (first())
      for (let i = 0; i < slots; i++) {
        const slot = join(dir, `slot-${i}`);
        try {
          mkdirSync(slot);
          writeFileSync(join(slot, "pid"), String(process.pid));
          rmSync(join(queue, ticket), { force: true });
          return () => rmSync(slot, { recursive: true, force: true });
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
          let owner = 0;
          try {
            owner = Number(readFileSync(join(slot, "pid"), "utf8"));
          } catch {
            continue; // being made right now
          }
          if (owner && !alive(owner))
            rmSync(slot, { recursive: true, force: true });
        }
      }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Starts the relay for one provider: returns the device profile for the
 * worker's agent-profiles.local.json and a stop function.
 */
export function startConnectionRelay(
  provider,
  runDir,
  log = () => {},
  net = null,
) {
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
    let closed = false;
    // A connection that cannot be served ends; the relay goes on.
    const onHeader = (chunk) =>
      serve(chunk).catch((error) => {
        log(`connection relay: ${error.code || error.message}`);
        socket.destroy();
      });
    const serve = async (chunk) => {
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
      // A computer's gateway client serves a limited number of open
      // connections: helpers of every shard of a parallel run share them
      // (PA_EVAL_HELPER_SLOTS), the rest wait their turn.
      socket.pause();
      const release = await helperSlot();
      if (closed) {
        release();
        return;
      }
      // The run folder, not TMPDIR: a lease's temporary folder may go away
      // while the run goes on.
      const directory = mkdtempSync(join(runDir, "connection-"));
      child = spawn(executable, args, {
        cwd: directory,
        // The helper runs on this computer, outside the sandbox: it gets
        // this computer's basic variables (its home holds the gateway's own
        // state), as a helper the person's Worker starts does; the
        // sandbox's own (its run-folder home) are ignored.
        env: { ...hostBasics(), TMPDIR: directory },
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.add(child);
      served++;
      let stderrTail = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (c) => {
        stderrTail = (stderrTail + c).slice(-4096);
      });
      relayReply(child.stdout, socket, net, log);
      if (rest.length) child.stdin.write(rest);
      socket.pipe(child.stdin);
      child.stdin.on("error", () => {});
      child.on("close", (status) => {
        release();
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
      closed = true;
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
