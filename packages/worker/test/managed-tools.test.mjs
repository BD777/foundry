import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FOUNDRY_TOOLS_ROOT = mkdtempSync(join(tmpdir(), "tools-root-"));
const { installTool, managedToolVersions, managedToolsBin, withManagedTools } =
  await import("../dist/managed-tools.js");
const { checkPrograms } = await import("../dist/skill-requirements.js");

const os = process.platform === "darwin" ? "darwin" : "linux";
const arch = process.arch === "x64" ? "amd64" : "arm64";

function tarball(files, links = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tool-src-"));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), body, { mode: 0o755 });
  }
  for (const [name, target] of Object.entries(links)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    symlinkSync(target, join(dir, name));
  }
  const out = join(mkdtempSync(join(tmpdir(), "tool-tar-")), "a.tar.gz");
  execFileSync("tar", ["-czf", out, "-C", dir, "."]);
  return readFileSync(out);
}

async function serve(routes) {
  const server = createServer((request, response) => {
    const body = routes[request.url];
    if (body === undefined) {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

test("a release binary is installed, checked and put first on PATH", async () => {
  const archive = tarball({
    "demo-tool_v1.0.0/demo-tool": "#!/bin/sh\necho v1\n",
    "demo-tool_v1.0.0/README": "readme",
  });
  const sum = createHash("sha256").update(archive).digest("hex");
  const assetName = `demo-tool_v1.0.0_${os}-${arch}.tar.gz`;
  const { server, origin } = await serve({
    "/a.tar.gz": archive,
    "/checksums.txt": `${sum}  ${assetName}\n0000  other.tar.gz\n`,
  });
  try {
    const spec = {
      name: "demo-tool",
      version: "v1.0.0",
      assets: [{ os, arch, name: assetName, url: `${origin}/a.tar.gz` }],
      checksumsUrl: `${origin}/checksums.txt`,
    };
    await assert.rejects(installTool(spec), /refusing to download/);
    const installed = await installTool(spec, { allowedOrigins: [origin] });
    assert.equal(installed.version, "v1.0.0");
    assert.deepEqual(managedToolVersions(), { "demo-tool": "v1.0.0" });
    assert.equal(
      readlinkSync(join(managedToolsBin(), "demo-tool")),
      "../demo-tool/v1.0.0/demo-tool",
    );
    assert.equal(
      execFileSync(join(managedToolsBin(), "demo-tool")).toString(),
      "v1\n",
    );
    assert.ok(withManagedTools("/usr/bin").startsWith(`${managedToolsBin()}:`));
    assert.deepEqual(checkPrograms(["demo-tool"]), { "demo-tool": true });

    // A tampered download does not match the release's checksum.
    const bad = { ...spec, version: "v1.0.1" };
    const { server: other, origin: otherOrigin } = await serve({
      "/a.tar.gz": tarball({ "demo-tool": "evil" }),
      "/checksums.txt": `${sum}  ${assetName}\n`,
    });
    try {
      bad.assets = [{ ...spec.assets[0], url: `${otherOrigin}/a.tar.gz` }];
      bad.checksumsUrl = `${otherOrigin}/checksums.txt`;
      await assert.rejects(
        installTool(bad, { allowedOrigins: [otherOrigin] }),
        /does not match/,
      );
    } finally {
      other.close();
    }
    assert.deepEqual(managedToolVersions(), { "demo-tool": "v1.0.0" });
  } finally {
    server.close();
  }
});

test("only a regular file named after the tool is taken from an archive", async () => {
  const archive = tarball({}, { "link-tool": "/etc/passwd" });
  const assetName = `link-tool_${os}-${arch}.tar.gz`;
  const { server, origin } = await serve({ "/a.tar.gz": archive });
  try {
    await assert.rejects(
      installTool(
        {
          name: "link-tool",
          version: "v1",
          assets: [{ os, arch, name: assetName, url: `${origin}/a.tar.gz` }],
        },
        { allowedOrigins: [origin] },
      ),
      /not a file/,
    );
    await assert.rejects(
      installTool({ name: "../x", version: "v1", assets: [] }),
      /invalid tool name/,
    );
  } finally {
    server.close();
  }
});
