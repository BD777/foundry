#!/usr/bin/env node
// Installs the packed worker the way `npx @bd777/foundry-worker` does and fails
// when the download grows past the budget or carries an agent program. Foundry
// uses the device's own Claude Code and Codex; their SDKs' bundled binaries
// (hundreds of MB each) must never come along.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const budgetMB = 150;
// The agent programs, and the SDKs themselves: those are optional peers that
// the service runtime install adds, so the bootstrap download stays small.
const forbidden = /^@anthropic-ai\/claude-agent-sdk|^@openai\/codex(-|$)/;

const root = mkdtempSync(join(tmpdir(), "foundry-footprint-"));
try {
  const packs = join(root, "packs");
  const tarballs = ["packages/protocol", "packages/worker"].map((dir) => {
    const out = execFileSync("pnpm", ["pack", "--pack-destination", packs], {
      cwd: dir,
      encoding: "utf8",
    });
    return out.trim().split("\n").at(-1);
  });
  const prefix = join(root, "install");
  execFileSync(
    "npm",
    ["install", "--no-audit", "--no-fund", "--prefix", prefix, ...tarballs],
    { cwd: root, stdio: ["ignore", "ignore", "inherit"] },
  );

  const modules = join(prefix, "node_modules");
  // Without the SDKs the CLI must still start: they load only when a session runs.
  for (const bin of ["cli.js", "foundry-cli.js"]) {
    execFileSync(
      process.execPath,
      [join(modules, "@bd777/foundry-worker/dist", bin), "--help"],
      { stdio: "ignore" },
    );
  }
  const packages = new Map();
  for (const entry of readdirSync(modules)) {
    if (entry.startsWith(".")) continue;
    const names = entry.startsWith("@")
      ? readdirSync(join(modules, entry)).map((name) => `${entry}/${name}`)
      : [entry];
    for (const name of names) packages.set(name, size(join(modules, name)));
  }
  const totalMB = mb(size(modules));
  const largest = [...packages].sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.log(
    `worker install footprint: ${totalMB} MB (budget ${budgetMB} MB); largest: ` +
      largest.map(([name, bytes]) => `${name} ${mb(bytes)} MB`).join(", "),
  );

  const failures = [...packages.keys()]
    .filter((name) => forbidden.test(name))
    .map(
      (name) =>
        `${name} is installed, but the worker uses the device's Claude Code and Codex`,
    );
  if (totalMB > budgetMB)
    failures.push(`${totalMB} MB exceeds the ${budgetMB} MB budget`);
  if (failures.length) {
    for (const failure of failures) console.error(`footprint: ${failure}`);
    process.exit(1);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

function size(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of readdirSync(path)) total += size(join(path, entry));
  return total;
}

function mb(bytes) {
  return Math.round(bytes / 1024 / 1024);
}
