import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FOUNDRY_TOOLS_ROOT = mkdtempSync(join(tmpdir(), "tools-root-"));
process.env.npm_config_cache = mkdtempSync(join(tmpdir(), "npm-cache-"));
const { installTool, runToolSetup, managedToolVersions, managedToolsBin } =
  await import("../dist/managed-tools.js");

function npmTarball(name, version, files) {
  const dir = mkdtempSync(join(tmpdir(), "npm-src-"));
  const root = join(dir, "package");
  mkdirSync(root);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name,
      version,
      bin: { [name]: "cli.js", [`${name}-setup`]: "setup.js" },
      scripts: { postinstall: "touch postinstall-ran" },
    }),
  );
  for (const [file, body] of Object.entries(files))
    writeFileSync(join(root, file), body, { mode: 0o644 });
  const out = join(mkdtempSync(join(tmpdir(), "npm-tar-")), "p.tgz");
  execFileSync("tar", ["-czf", out, "-C", dir, "package"]);
  return readFileSync(out);
}

async function fakeRegistry(name, versions) {
  const tarballs = {};
  let origin = "";
  const server = createServer((request, response) => {
    if (request.url === `/${name}`) {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          name,
          "dist-tags": { latest: Object.keys(versions).at(-1) },
          versions: Object.fromEntries(
            Object.keys(versions).map((version) => [
              version,
              {
                name,
                version,
                bin: { [name]: "cli.js", [`${name}-setup`]: "setup.js" },
                dist: {
                  tarball: `${origin}/${name}/-/${name}-${version}.tgz`,
                  integrity: `sha512-${createHash("sha512").update(tarballs[version]).digest("base64")}`,
                },
              },
            ]),
          ),
        }),
      );
      return;
    }
    const match = request.url.match(/-(\d+\.\d+\.\d+)\.tgz$/);
    if (match && tarballs[match[1]]) {
      response.end(tarballs[match[1]]);
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  for (const [version, files] of Object.entries(versions))
    tarballs[version] = npmTarball(name, version, files);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, registry: `${origin}/` };
}

test("an npm tool installs per version without its install scripts and runs its setup on request", async () => {
  const cli = (label) =>
    `#!/usr/bin/env node\nconsole.log("${label} " + process.argv.slice(2).join(" "));\n`;
  const { server, registry } = await fakeRegistry("demo-npm-tool", {
    "1.0.0": { "cli.js": cli("v1"), "setup.js": cli("setup") },
    "1.1.0": { "cli.js": cli("v1.1"), "setup.js": cli("setup") },
  });
  try {
    const spec = {
      name: "demo-npm-tool",
      version: "1.0.0",
      source: "npm",
      package: "demo-npm-tool",
      setup: { command: "demo-npm-tool-setup", args: ["install", "chromium"] },
    };
    await assert.rejects(
      runToolSetup(spec),
      /install demo-npm-tool 1.0.0 before/,
    );
    await installTool(spec, { npmRegistry: registry });
    await installTool({ ...spec, version: "1.1.0" }, { npmRegistry: registry });
    assert.equal(managedToolVersions()["demo-npm-tool"], "1.1.0");
    const command = join(managedToolsBin(), "demo-npm-tool");
    assert.equal(execFileSync(command, ["x"]).toString(), "v1.1 x\n");
    const folder = join(process.env.FOUNDRY_TOOLS_ROOT, "demo-npm-tool");
    assert.ok(!existsSync(join(folder, "1.1.0", "npm", "postinstall-ran")));
    assert.ok(
      !existsSync(
        join(
          folder,
          "1.1.0",
          "npm",
          "node_modules",
          "demo-npm-tool",
          "postinstall-ran",
        ),
      ),
    );

    // Versions stay side by side: making 1.0.0 current again needs no download.
    await installTool(spec, { npmRegistry: registry });
    assert.equal(execFileSync(command).toString(), "v1 \n");
    assert.equal(readlinkSync(command), "../demo-npm-tool/1.0.0/demo-npm-tool");

    const done = await runToolSetup(spec);
    assert.match(done.output, /setup install chromium/);
    await assert.rejects(
      runToolSetup({ ...spec, setup: { args: ["; rm -rf /"] } }),
      /invalid setup step/,
    );
    await assert.rejects(
      installTool({ ...spec, version: "9.9.9" }, { npmRegistry: registry }),
      /npm install demo-npm-tool@9.9.9 failed/,
    );
    assert.equal(managedToolVersions()["demo-npm-tool"], "1.0.0");
  } finally {
    server.close();
  }
});

test("a uv tool installs into its own version folder, and a device without uv is told so", async () => {
  const stubs = mkdtempSync(join(tmpdir(), "uv-stub-"));
  const log = join(stubs, "calls.log");
  writeFileSync(
    join(stubs, "uv"),
    [
      "#!/bin/sh",
      `echo "$@ dir=$UV_TOOL_DIR" >> '${log}'`,
      'mkdir -p "$UV_TOOL_BIN_DIR"',
      'printf \'#!/bin/sh\\necho py-tool "$@"\\n\' > "$UV_TOOL_BIN_DIR/py-tool"',
      'chmod +x "$UV_TOOL_BIN_DIR/py-tool"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const path = process.env.PATH;
  const home = process.env.HOME;
  const spec = {
    name: "py-tool",
    version: "0.13.11",
    source: "uv",
    package: "py-tool",
    setup: { args: ["--version"] },
  };
  try {
    process.env.PATH = `${stubs}:/usr/bin:/bin`;
    await installTool(spec);
    assert.equal(managedToolVersions()["py-tool"], "0.13.11");
    const calls = readFileSync(log, "utf8");
    assert.match(
      calls,
      /^tool install --force py-tool==0\.13\.11 dir=.*py-tool\/0\.13\.11\/uv$/m,
    );
    assert.equal(
      execFileSync(join(managedToolsBin(), "py-tool"), ["a"]).toString(),
      "py-tool a\n",
    );
    assert.match((await runToolSetup(spec)).output, /py-tool --version/);

    process.env.PATH = "/usr/bin:/bin";
    process.env.HOME = mkdtempSync(join(tmpdir(), "home-"));
    await assert.rejects(
      installTool({ ...spec, version: "0.14.0" }),
      /needs uv, which is not on this device/,
    );
  } finally {
    process.env.PATH = path;
    process.env.HOME = home;
  }
});
