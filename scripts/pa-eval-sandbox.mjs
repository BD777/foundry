// The eval's computers, sandboxed (scripts/pa-eval-run.mjs). With a model, the
// assistant is a full agent: on the host it would read the person's files and
// reach the services this computer runs (an earlier run read a real service's
// accounts). So each Worker runs in bubblewrap on a minimal root of its own:
// the system's programs (/usr) and a few files of /etc read-only, the Node
// runtime, the installed Worker and the Claude CLI under /opt, its own /tmp,
// and only the stack's run folder writable. /home, /var, /run (the Docker
// socket) and the rest of the host are not there; passwd, hosts and the host
// name are the fixture's own. It has its own network (--unshare-net): only
// loopback, and on it only the ports the harness bridges in, each a unix
// socket in the run folder that the harness forwards to the same port on the
// host: the stack's server, and a model connection's local adapter the
// connection helper names (pa-eval-connection-relay.mjs).
//
// Inside, a small bridge (bridge.cjs) listens on 127.0.0.1:<port> for every
// <port>.sock in the sandbox's own net folder, writes <port>.ready once it
// listens, then runs the command.

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer } from "node:net";
import { dirname, resolve } from "node:path";

const bridgeSource = `"use strict";
// The sandbox side of the eval's port bridge (scripts/pa-eval-sandbox.mjs).
const { spawn } = require("node:child_process");
const { existsSync, readdirSync, watch, writeFileSync } = require("node:fs");
const net = require("node:net");
const { join } = require("node:path");
const dir = process.env.PA_EVAL_NET_DIR;
const listening = new Set();
const listen = (port) =>
  new Promise((done) => {
    if (listening.has(port)) return done();
    listening.add(port);
    const server = net.createServer((client) => {
      const upstream = net.connect(join(dir, port + ".sock"));
      client.pipe(upstream).pipe(client);
      const close = () => { client.destroy(); upstream.destroy(); };
      client.on("error", close);
      upstream.on("error", close);
    });
    server.on("error", () => { listening.delete(port); done(); });
    server.listen(Number(port), "127.0.0.1", () => {
      writeFileSync(join(dir, port + ".ready"), "");
      done();
    });
  });
const scan = () =>
  Promise.all(
    readdirSync(dir)
      .map((f) => /^(\\d+)\\.sock$/.exec(f)?.[1])
      .filter((p) => p && !listening.has(p))
      .map(listen),
  );
scan().then(() => {
  try { watch(dir, () => scan()); } catch {}
  setInterval(scan, 300).unref();
  const [command, ...args] = process.argv.slice(2);
  const child = spawn(command, args, { stdio: "inherit" });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"])
    process.on(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
});
`;

/**
 * One sandboxed computer's network: `forward(port)` makes 127.0.0.1:port
 * inside reach the same port on the host; `ready(port)` waits until the
 * bridge inside listens on it.
 */
export class NetBridge {
  constructor(runDir, name) {
    this.dir = resolve(runDir, "net", name);
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.bridge = resolve(runDir, "net", "bridge.cjs");
    writeFileSync(this.bridge, bridgeSource, { mode: 0o600 });
    this.servers = new Map();
  }

  forward(port) {
    port = Number(port);
    if (this.servers.has(port)) return;
    const path = resolve(this.dir, `${port}.sock`);
    rmSync(path, { force: true });
    const server = createServer((socket) => {
      const upstream = connect(port, "127.0.0.1");
      socket.pipe(upstream).pipe(socket);
      const close = () => {
        socket.destroy();
        upstream.destroy();
      };
      socket.on("error", close);
      upstream.on("error", close);
    });
    server.listen(path);
    this.servers.set(port, server);
  }

  async ready(port, timeoutMs = 5000) {
    const path = resolve(this.dir, `${port}.ready`);
    const until = Date.now() + timeoutMs;
    while (!existsSync(path) && Date.now() < until)
      await new Promise((r) => setTimeout(r, 100));
    return existsSync(path);
  }

  stop() {
    for (const server of this.servers.values()) server.close();
    this.servers.clear();
  }
}

// /etc files a program may read; copied as they are (no person's data).
const etcFiles = [
  "ld.so.cache",
  "ld.so.conf",
  "localtime",
  "nsswitch.conf",
  "mime.types",
  "os-release",
];
const etcDirs = ["ssl", "ca-certificates", "alternatives", "ld.so.conf.d"];

/**
 * The bubblewrap command line for one sandboxed computer, then the bridge,
 * then `command`. `root` is the run folder (writable, at its real path);
 * `hostname` the computer's name; `node`, `runtime` and `claude` the host
 * paths of the Node install, the Worker's runtime folder and the Claude CLI,
 * mounted at /opt/node, /opt/foundry-runtime and /opt/bin/claude.
 * `loginDirs` are bound writable at their real paths (the legacy run on the
 * person's own login). Returns { argv, env, cli } with the PATH to use and
 * the Worker's CLI path inside.
 */
export function sandboxCommand({
  root,
  hostname,
  net,
  node,
  runtime,
  claude,
  cli,
  loginDirs = [],
}) {
  const bwrap = ["/usr/bin/bwrap", "/bin/bwrap"].find((p) => existsSync(p));
  if (!bwrap)
    throw new Error(
      "bubblewrap (bwrap) is needed to run the eval's computers without letting them reach this one",
    );
  const etc = resolve(root, "net", "etc", hostname);
  mkdirSync(etc, { recursive: true, mode: 0o700 });
  const uid = process.getuid();
  const gid = process.getgid();
  writeFileSync(
    resolve(etc, "passwd"),
    `root:x:0:0:root:/root:/bin/sh\npa:x:${uid}:${gid}:PA Eval:/tmp:/bin/bash\nnobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n`,
  );
  writeFileSync(
    resolve(etc, "group"),
    `root:x:0:\npa:x:${gid}:\nnogroup:x:65534:\n`,
  );
  writeFileSync(
    resolve(etc, "hosts"),
    `127.0.0.1 localhost ${hostname}\n::1 localhost\n`,
  );
  writeFileSync(resolve(etc, "hostname"), `${hostname}\n`);
  writeFileSync(resolve(etc, "resolv.conf"), "");
  const args = [
    bwrap,
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-net",
    "--hostname",
    hostname,
    "--die-with-parent",
    "--ro-bind",
    "/usr",
    "/usr",
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/sbin",
    "/sbin",
    "--symlink",
    "usr/lib",
    "/lib",
  ];
  if (existsSync("/usr/lib64")) args.push("--symlink", "usr/lib64", "/lib64");
  args.push("--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp");
  for (const f of etcFiles)
    if (existsSync(`/etc/${f}`))
      args.push("--ro-bind", `/etc/${f}`, `/etc/${f}`);
  for (const d of etcDirs)
    if (existsSync(`/etc/${d}`))
      args.push("--ro-bind", `/etc/${d}`, `/etc/${d}`);
  for (const f of ["passwd", "group", "hosts", "hostname", "resolv.conf"])
    args.push("--ro-bind", resolve(etc, f), `/etc/${f}`);
  args.push("--ro-bind", realpathSync(node), "/opt/node");
  if (runtime)
    args.push("--ro-bind", realpathSync(runtime), "/opt/foundry-runtime");
  if (claude) args.push("--ro-bind", realpathSync(claude), "/opt/bin/claude");
  // Writable last, so nothing mounted above covers them.
  for (const dir of loginDirs)
    if (existsSync(dir)) args.push("--bind", dir, dir);
  args.push("--bind", root, root, "--chdir", root);
  // The sandbox's own root (where /etc's files are mounted) is read-only too.
  args.push("--remount-ro", "/");
  args.push("--", "/opt/node/bin/node", net.bridge);
  const inside = runtime
    ? resolve(
        "/opt/foundry-runtime",
        cli.slice(realpathSync(runtime).length + 1),
      )
    : cli;
  return {
    argv: args,
    env: {
      PATH: "/opt/bin:/opt/node/bin:/usr/local/bin:/usr/bin:/bin",
      PA_EVAL_NET_DIR: net.dir,
    },
    cli: inside,
  };
}

/** The Node install running this script (its folder: bin/node's parent's parent). */
export const nodeInstall = () =>
  dirname(dirname(realpathSync(process.execPath)));

/** The runtime folder of an installed Worker CLI (…/node_modules/@scope/pkg/dist/cli.js). */
export const runtimeOf = (cli) => resolve(realpathSync(cli), "../../../../..");

/** Runs a sandboxed command to its end (the bridge needs this process free). */
export function runToEnd(argv, env) {
  return new Promise((done) => {
    const child = spawn(argv[0], argv.slice(1), {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (c) => (stdout += c));
    child.stderr.setEncoding("utf8").on("data", (c) => (stderr += c));
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
}
