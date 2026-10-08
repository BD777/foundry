#!/usr/bin/env node
// Packs this checkout's worker for a server to serve (FOUNDRY_WORKER_PACKAGES):
// the protocol and worker tarballs plus release.json, so devices paired with
// that server install and update to this build without an npm release.
//
//   node scripts/pack-worker-release.mjs --out <dir>
//
// The version says what the build is: the next patch after the last release
// tag, "dev", commits since that tag and the commit (0.5.7-dev.2.gc258bdd),
// plus a timestamp when the packages have uncommitted changes. Only the packed
// copies carry it; the checkout's package.json files are left alone.

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packages = ["protocol", "worker"];
const protocolName = "@bd777/foundry-protocol";

const outIndex = process.argv.indexOf("--out");
const outArg = outIndex >= 0 ? process.argv[outIndex + 1] : undefined;
if (!outArg) {
  console.error("usage: pack-worker-release.mjs --out <dir>");
  process.exit(2);
}
const out = resolve(outArg);

const run = (command, args, cwd = root) =>
  execFileSync(command, args, { cwd, encoding: "utf8" }).trim();

function buildVersion() {
  const described = run("git", [
    "describe",
    "--tags",
    "--match",
    "v[0-9]*",
    "--long",
  ]);
  const match = /^v(\d+)\.(\d+)\.(\d+)-(\d+)-(g[0-9a-f]+)$/.exec(described);
  if (!match) throw new Error(`unexpected git describe output: ${described}`);
  const [, major, minor, patch, commits, commit] = match;
  let version = `${major}.${minor}.${Number(patch) + 1}-dev.${commits}.${commit}`;
  const dirty = run("git", [
    "status",
    "--porcelain",
    "--",
    ...packages.map((name) => `packages/${name}`),
  ]);
  if (dirty) version += `.local.${Math.floor(Date.now() / 1000)}`;
  return version;
}

const version = buildVersion();
const work = mkdtempSync(join(tmpdir(), "foundry-worker-release-"));
try {
  const files = [];
  for (const name of packages) {
    const raw = join(work, `raw-${name}`);
    // pnpm pack builds the package (prepack) and resolves workspace:*.
    run(
      "pnpm",
      ["pack", "--pack-destination", raw],
      join(root, "packages", name),
    );
    const [tarball] = readdirSync(raw);
    const extracted = join(work, `x-${name}`);
    mkdirSync(extracted);
    run("tar", ["xzf", join(raw, tarball), "-C", extracted]);
    const manifestPath = join(extracted, "package", "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.version = version;
    if (manifest.dependencies?.[protocolName])
      manifest.dependencies[protocolName] = version;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const packed = run(
      "npm",
      ["pack", "--silent", "--pack-destination", work],
      join(extracted, "package"),
    );
    files.push({ name: manifest.name, file: packed.split("\n").pop() });
  }

  mkdirSync(out, { recursive: true });
  // A copy, not a rename: the temporary directory may be on another device.
  for (const { file } of files) copyFileSync(join(work, file), join(out, file));
  // release.json switches servers to the new build only once its files exist.
  const release = join(out, ".release.json.tmp");
  writeFileSync(
    release,
    `${JSON.stringify({ version, packages: files }, null, 2)}\n`,
  );
  renameSync(release, join(out, "release.json"));
  const kept = new Set(["release.json", ...files.map(({ file }) => file)]);
  for (const entry of readdirSync(out))
    if (entry.endsWith(".tgz") && !kept.has(entry))
      rmSync(join(out, entry), { force: true });
  console.log(`Packed worker ${version} into ${out}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
