import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "worker-runtime-"));
process.env.FOUNDRY_STATE_ROOT = join(root, "state");
// The test sandbox keeps HOME read-only, so npm gets its cache here.
process.env.npm_config_cache = join(root, "npm-cache");
const { installRuntime, runtimeRoot } =
  await import("../dist/worker-install.js");

function pack(marker) {
  const source = join(root, `pkg-${marker}`);
  mkdirSync(source, { recursive: true });
  writeFileSync(
    join(source, "package.json"),
    JSON.stringify({ name: "fake-worker", version: "1.0.0" }),
  );
  writeFileSync(join(source, "marker.txt"), marker);
  const out = join(root, `out-${marker}`);
  mkdirSync(out);
  execFileSync("npm", ["pack", "--pack-destination", out], {
    cwd: source,
    stdio: "ignore",
  });
  return join(out, "fake-worker-1.0.0.tgz");
}

const installed = () =>
  readFileSync(
    join(runtimeRoot(), "current", "node_modules", "fake-worker", "marker.txt"),
    "utf8",
  );

test(
  "reinstalling the running version from a local build really installs it",
  { timeout: 120000 },
  () => {
    assert.equal(installRuntime("fake-worker", [pack("first")]), "1.0.0");
    assert.equal(installed(), "first");
    const running = readlinkSync(join(runtimeRoot(), "current"));
    assert.equal(installRuntime("fake-worker", [pack("second")]), "1.0.0");
    assert.equal(installed(), "second", "the new build replaced the old one");
    assert.notEqual(
      readlinkSync(join(runtimeRoot(), "current")),
      running,
      "the running copy was not replaced in place",
    );
    assert.equal(
      readFileSync(
        join(
          runtimeRoot(),
          running,
          "node_modules",
          "fake-worker",
          "marker.txt",
        ),
        "utf8",
      ),
      "first",
    );
  },
);

test(
  "install writes this machine's foundry-worker command, running the current runtime with its stack",
  { skip: process.platform !== "darwin" && process.platform !== "linux" },
  async () => {
    const { writeWorkerShim, workerShimPath } =
      await import("../dist/worker-install.js");
    const cli = join(
      runtimeRoot(),
      "current",
      "node_modules",
      "fake-shim",
      "dist",
      "cli.js",
    );
    mkdirSync(dirname(cli), { recursive: true });
    writeFileSync(
      cli,
      "console.log(JSON.stringify({ args: process.argv.slice(2), root: process.env.FOUNDRY_STATE_ROOT }));",
    );
    const path = writeWorkerShim("fake-shim");
    assert.equal(path, workerShimPath());
    assert.ok(statSync(path).mode & 0o111, "the command is executable");
    const out = JSON.parse(
      execFileSync(path, ["--help"], {
        encoding: "utf8",
        env: { PATH: process.env.PATH },
      }),
    );
    assert.deepEqual(out.args, ["--help"]);
    assert.equal(out.root, process.env.FOUNDRY_STATE_ROOT);
  },
);
