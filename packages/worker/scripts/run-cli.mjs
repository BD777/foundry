#!/usr/bin/env node

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, "..");
const protocolDir = resolve(packageDir, "../protocol");
const distEntry = join(packageDir, "dist", "cli.js");

function newestMtime(path) {
  if (!existsSync(path)) {
    return 0;
  }
  const stat = statSync(path);
  if (!stat.isDirectory()) {
    return stat.mtimeMs;
  }
  return readdirSync(path).reduce((latest, child) => {
    return Math.max(latest, newestMtime(join(path, child)));
  }, stat.mtimeMs);
}

const distMtime = newestMtime(distEntry);
const sourceMtime = Math.max(
  newestMtime(join(packageDir, "src")),
  newestMtime(join(packageDir, "package.json")),
  newestMtime(join(packageDir, "tsconfig.json")),
  newestMtime(join(protocolDir, "src")),
  newestMtime(join(protocolDir, "package.json")),
  newestMtime(join(protocolDir, "tsconfig.json")),
);

if (distMtime === 0 || sourceMtime > distMtime) {
  const protocolBuild = spawnSync("pnpm", ["build"], {
    cwd: protocolDir,
    stdio: "inherit",
  });
  if (protocolBuild.status !== 0) {
    process.exit(protocolBuild.status ?? 1);
  }
  const build = spawnSync("pnpm", ["build"], {
    cwd: packageDir,
    stdio: "inherit",
  });
  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }
}

const cli = spawnSync(process.execPath, [distEntry, ...process.argv.slice(2)], {
  cwd: packageDir,
  stdio: "inherit",
});

if (cli.signal) {
  process.kill(process.pid, cli.signal);
}
process.exit(cli.status ?? 1);
