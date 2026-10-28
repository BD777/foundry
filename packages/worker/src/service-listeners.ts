import { execFile } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { basename, sep } from "node:path";
import type { ServiceListener } from "@bd777/foundry-protocol";
import { isProtectedHTTPPort } from "./protected-http-ports.js";

const maxListeners = 128;
const interpreters = /^(node|nodejs|bun|deno|python[0-9.]*|ruby|php|perl)$/;

/** Ports a registered tunnel could reach: it dials 127.0.0.1, so a listener
 * bound to IPv4 loopback/any or to the dual-stack IPv6 any address counts. */
export function reachableLinuxAddress(hex: string, v6: boolean): boolean {
  if (!v6) {
    // Little-endian IPv4: 0100007F is 127.0.0.1; any 127/8 ends in 7F.
    return hex === "00000000" || hex.endsWith("7F");
  }
  if (/^0{32}$/.test(hex)) return true;
  // ::ffff:a.b.c.d as four little-endian words.
  if (!hex.startsWith("0000000000000000FFFF0000")) return false;
  const v4 = hex.slice(24);
  return v4 === "00000000" || v4.endsWith("7F");
}

/** LISTEN sockets in /proc/net/tcp{,6} text: port -> socket inodes. */
export function parseLinuxListeners(
  text: string,
  v6: boolean,
): Map<number, string[]> {
  const ports = new Map<number, string[]>();
  for (const line of text.split("\n").slice(1)) {
    const [, local = "", , state, , , , , , inode = ""] = line
      .trim()
      .split(/\s+/);
    const [address = "", portHex] = local.split(":");
    if (state !== "0A" || !inode || !portHex) continue;
    if (!reachableLinuxAddress(address, v6)) continue;
    const port = parseInt(portHex, 16);
    ports.set(port, [...(ports.get(port) || []), inode]);
  }
  return ports;
}

/** A display name that never includes arguments beyond a script's name. */
export function processLabel(argv: string[]): string | undefined {
  const command = argv[0] ? basename(argv[0]) : "";
  if (!command) return undefined;
  const script = argv.slice(1).find((arg) => !arg.startsWith("-"));
  const label =
    interpreters.test(command) && script
      ? `${command} ${basename(script)}`
      : command;
  return label.slice(0, 60);
}

interface Owner {
  pid: number;
  process?: string;
  cwd?: string;
}

function linuxOwners(inodes: Set<string>): Map<string, Owner> {
  const owners = new Map<string, Owner>();
  let pids: string[] = [];
  try {
    pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {
    return owners;
  }
  for (const pid of pids) {
    if (owners.size === inodes.size) break;
    let fds: string[];
    try {
      // Other users' processes are unreadable: their ports still count as
      // listening, with no process or workspace attribution.
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let target: string;
      try {
        target = readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
      if (!inode || !inodes.has(inode) || owners.has(inode)) continue;
      const owner: Owner = { pid: Number(pid) };
      try {
        owner.process = processLabel(
          readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0"),
        );
        owner.cwd = readlinkSync(`/proc/${pid}/cwd`);
      } catch {
        /* exited meanwhile */
      }
      owners.set(inode, owner);
    }
  }
  return owners;
}

function linuxListeners(): Map<number, Owner | undefined> {
  const ports = new Map<number, string[]>();
  for (const [file, v6] of [
    ["/proc/net/tcp", false],
    ["/proc/net/tcp6", true],
  ] as const) {
    try {
      for (const [port, inodes] of parseLinuxListeners(
        readFileSync(file, "utf8"),
        v6,
      ))
        ports.set(port, [...(ports.get(port) || []), ...inodes]);
    } catch {
      /* no IPv6 */
    }
  }
  const owners = linuxOwners(new Set([...ports.values()].flat()));
  const result = new Map<number, Owner | undefined>();
  for (const [port, inodes] of ports)
    result.set(port, inodes.map((inode) => owners.get(inode)).find(Boolean));
  return result;
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve) =>
    execFile(file, args, { timeout: 3000, maxBuffer: 4 << 20 }, (_e, out) =>
      resolve(String(out || "")),
    ),
  );
}

/** lsof -F output: p<pid>, c<command>, n<name> records. */
export function parseLsofListeners(
  text: string,
): Map<number, Owner | undefined> {
  const result = new Map<number, Owner | undefined>();
  let owner: Owner | undefined;
  for (const line of text.split("\n")) {
    const value = line.slice(1);
    if (line[0] === "p") owner = { pid: Number(value) };
    else if (line[0] === "c" && owner) owner.process = value.slice(0, 60);
    else if (line[0] === "n" && owner) {
      const match =
        /^(\*|127\.[\d.]+|\[::\]|\[::ffff:127\.[\d.]+\]):(\d+)$/.exec(value);
      if (match && !result.get(Number(match[2])))
        result.set(Number(match[2]), owner);
    }
  }
  return result;
}

async function lsofListeners(): Promise<Map<number, Owner | undefined>> {
  const result = parseLsofListeners(
    await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"]),
  );
  const pids = [
    ...new Set([...result.values()].flatMap((o) => (o ? [o.pid] : []))),
  ];
  if (!pids.length) return result;
  const cwds = new Map<number, string>();
  let pid = 0;
  for (const line of (
    await run("lsof", ["-a", "-d", "cwd", "-p", pids.join(","), "-Fpn"])
  ).split("\n")) {
    if (line[0] === "p") pid = Number(line.slice(1));
    else if (line[0] === "n") cwds.set(pid, line.slice(1));
  }
  for (const owner of result.values())
    if (owner) owner.cwd = cwds.get(owner.pid);
  return result;
}

function inside(cwd: string | undefined, root: string): boolean {
  return Boolean(cwd) && (cwd === root || cwd!.startsWith(root + sep));
}

/**
 * Local listeners for Workspace Services: liveness of registered ports and
 * candidates started from this workspace's folder. Observation only; nothing
 * is published, scanned remotely or launched.
 */
export async function listServiceListeners(
  workspacePath: string,
  excluded: number[] = [],
): Promise<ServiceListener[]> {
  let root = workspacePath;
  try {
    root = realpathSync(workspacePath);
  } catch {
    /* compare as given */
  }
  const found =
    process.platform === "linux" ? linuxListeners() : await lsofListeners();
  const listeners: ServiceListener[] = [];
  for (const [port, owner] of [...found].sort((a, b) => a[0] - b[0])) {
    if (
      port < 1024 ||
      excluded.includes(port) ||
      isProtectedHTTPPort(port) ||
      listeners.length >= maxListeners
    )
      continue;
    listeners.push({
      port,
      ...(owner?.process ? { process: owner.process } : {}),
      inWorkspace: inside(owner?.cwd, root),
    });
  }
  return listeners;
}
