// The GitHub CLI connector (connectors/github.ts, gh-install.ts): reading
// gh's login in its old and new words, the device-code sign-in it relays,
// sessions kept from the login, and installing gh from a release archive
// whose checksum is checked. No real gh or network is used.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  githubAdapter,
  parseGhAuthStatus,
  parseGhDeviceCode,
} from "../dist/connectors/github.js";
import { DeviceHeldConnectors } from "../dist/connectors/device-held.js";
import {
  checksumFor,
  ghArchiveName,
  installGitHubCli,
  versionFromReleaseLocation,
} from "../dist/connectors/gh-install.js";
import { fetchRetrying } from "../dist/connectors/download.js";

test("gh's login is read in both its wordings, without the token", () => {
  assert.deepEqual(
    parseGhAuthStatus({
      code: 0,
      stdout:
        "github.com\n  ✓ Logged in to github.com account octo-cat (keyring)\n  - Token: gho_************\n",
      stderr: "",
    }),
    { signedIn: true, identity: "octo-cat" },
  );
  assert.deepEqual(
    parseGhAuthStatus({
      code: 0,
      stdout: "",
      stderr:
        "github.com\n  ✓ Logged in to github.com as octo-cat (oauth_token)\n",
    }),
    { signedIn: true, identity: "octo-cat" },
  );
  for (const output of [
    "You are not logged into any GitHub hosts. To log in, run: gh auth login",
    "github.com\n  X Failed to log in to github.com account octo-cat (keyring)\n  - The token in keyring is invalid.",
  ])
    assert.deepEqual(
      parseGhAuthStatus({ code: 1, stdout: "", stderr: output }),
      {
        signedIn: false,
      },
    );
});

test("the sign-in relays gh's one-time code and page", () => {
  assert.deepEqual(
    parseGhDeviceCode(
      "! First copy your one-time code: AB12-CD34\nOpen this URL to continue in your web browser: https://github.com/login/device\n",
    ),
    { code: "AB12-CD34", url: "https://github.com/login/device" },
  );
  assert.equal(
    parseGhDeviceCode("! First copy your one-time code:"),
    undefined,
  );
});

test("a session that may not use the login gets an empty gh configuration", () => {
  const environment = githubAdapter.isolationEnvironment();
  assert.ok(environment.GH_CONFIG_DIR && existsSync(environment.GH_CONFIG_DIR));
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"])
    assert.equal(environment[name], "");
  // Foundry's own runs never open a browser on the device.
  assert.equal(githubAdapter.runEnvironment.GH_BROWSER, "true");
});

test("release archives are named for the machine", () => {
  assert.equal(
    ghArchiveName("2.60.1", "linux", "x64"),
    "gh_2.60.1_linux_amd64.tar.gz",
  );
  assert.equal(
    ghArchiveName("2.60.1", "darwin", "arm64"),
    "gh_2.60.1_macOS_arm64.zip",
  );
  assert.throws(
    () => ghArchiveName("2.60.1", "win32", "x64"),
    /Linux and macOS/,
  );
  assert.throws(() => ghArchiveName("2.60.1", "linux", "ia32"), /processors/);
  assert.throws(
    () => checksumFor("abc  gh.tar.gz\n", "gh.tar.gz"),
    /no checksum/,
  );
});

test(
  "gh installs from a release archive whose checksum matches",
  { skip: process.platform !== "linux" },
  async () => {
    const home = mkdtempSync(join(tmpdir(), "fdy-gh-home-"));
    const managedBin = join(home, "tools");
    const version = "2.60.1";
    const name = ghArchiveName(
      version,
      "linux",
      process.arch === "arm64" ? "arm64" : "x64",
    );
    // A release archive whose bin/gh prints its version.
    const build = mkdtempSync(join(tmpdir(), "fdy-gh-build-"));
    const folder = name.replace(/\.tar\.gz$/, "");
    mkdirSync(join(build, folder, "bin"), { recursive: true });
    writeFileSync(
      join(build, folder, "bin", "gh"),
      `#!/bin/sh\necho "gh version ${version} (2025-01-01)"\n`,
    );
    chmodSync(join(build, folder, "bin", "gh"), 0o755);
    const archive = join(build, name);
    execFileSync("tar", ["-czf", archive, "-C", build, folder]);
    const sum = createHash("sha256")
      .update(execFileSync("cat", [archive]))
      .digest("hex");
    const checksums = join(build, "checksums.txt");
    writeFileSync(checksums, `${sum}  ${name}\n`);
    const fetched = [];
    const download = async (url, file) => {
      fetched.push(url);
      copyFileSync(url.endsWith("_checksums.txt") ? checksums : archive, file);
    };
    const result = await installGitHubCli({
      managedBin,
      home,
      platform: "linux",
      arch: process.arch === "arm64" ? "arm64" : "x64",
      latestVersion: async () => version,
      download,
      path: "",
    });
    assert.equal(result.version, version);
    assert.deepEqual(fetched, [
      `https://github.com/cli/cli/releases/download/v${version}/gh_${version}_checksums.txt`,
      `https://github.com/cli/cli/releases/download/v${version}/${name}`,
    ]);
    const installed = join(
      home,
      ".local",
      "share",
      "gh-cli",
      version,
      "bin",
      "gh",
    );
    assert.equal(readlinkSync(join(managedBin, "gh")), installed);
    assert.equal(readlinkSync(join(home, ".local", "bin", "gh")), installed);

    // Another program named gh on PATH keeps the terminal's gh: only
    // Foundry's tools link to the install.
    const other = mkdtempSync(join(tmpdir(), "fdy-gh-other-"));
    writeFileSync(join(other, "gh"), "#!/bin/sh\n", { mode: 0o755 });
    const home2 = mkdtempSync(join(tmpdir(), "fdy-gh-home-"));
    await installGitHubCli({
      managedBin: join(home2, "tools"),
      home: home2,
      platform: "linux",
      arch: process.arch === "arm64" ? "arm64" : "x64",
      latestVersion: async () => version,
      download,
      path: `${join(home2, ".local", "bin")}:${other}`,
    });
    assert.ok(existsSync(join(home2, "tools", "gh")));
    assert.ok(!existsSync(join(home2, ".local", "bin", "gh")));

    // A mismatching archive is refused before anything is unpacked.
    writeFileSync(checksums, `${"0".repeat(64)}  ${name}\n`);
    await assert.rejects(
      installGitHubCli({
        managedBin,
        home,
        platform: "linux",
        arch: process.arch === "arm64" ? "arm64" : "x64",
        latestVersion: async () => version,
        download,
      }),
      /does not match/,
    );
  },
);

test("another program named gh reads as not installed, so Foundry offers its own", async () => {
  // A company host-lookup tool installed as /usr/local/bin/gh answers like this.
  const foreign = async () => ({
    code: 1,
    stdout: "",
    stderr:
      "Error: unknown flag: --version\nUsage:\n  gh [target [target ...]]  [flags]\n",
  });
  await assert.rejects(githubAdapter.readVersion(foreign), {
    message: /another program, not GitHub CLI/,
  });
  // GitHub CLI that fails without saying who it is stays a read failure.
  await assert.rejects(
    githubAdapter.readVersion(async () => ({
      code: 1,
      stdout: "",
      stderr: "",
    })),
    { message: "Could not read the GitHub CLI version." },
  );
  assert.equal(
    await githubAdapter.readVersion(async () => ({
      code: 0,
      stdout:
        "gh version 2.67.0 (2025-02-11)\nhttps://github.com/cli/cli/releases/tag/v2.67.0\n",
      stderr: "",
    })),
    "2.67.0",
  );

  const descriptor = JSON.parse(
    readFileSync(
      new URL(
        "../../../apps/server/internal/connectors/catalog.json",
        import.meta.url,
      ),
    ),
  ).find((x) => x.kind === "github");
  const root = mkdtempSync(join(tmpdir(), "fdy-gh-foreign-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    "#!/bin/sh\necho 'Error: unknown flag: --version' >&2\nexit 1\n",
    { mode: 0o755 },
  );
  const previous = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const runtime = new DeviceHeldConnectors({
      adapters: { github: githubAdapter },
      managedBin: () => join(root, "managed"),
      toolDirs: [bin],
    });
    const { state } = await runtime.handle({
      action: "status",
      connector: descriptor,
      fresh: true,
    });
    assert.equal(state.status, "not_installed");
    assert.equal(state.installed, false);
    assert.equal(state.installSource, undefined);
    assert.match(state.statusDetail, /another program/);
  } finally {
    process.env.PATH = previous;
  }
});

test("the newest GitHub CLI comes from the release page's redirect, not the rate-limited API", () => {
  assert.equal(
    versionFromReleaseLocation(
      "https://github.com/cli/cli/releases/tag/v2.103.3",
    ),
    "2.103.3",
  );
  assert.throws(
    () => versionFromReleaseLocation("https://github.com/login"),
    /without a GitHub CLI version/,
  );
});

test("a connection that fails before any answer is tried again; an answer is returned as it is", async (t) => {
  const server = createServer((request, response) => {
    response.writeHead(302, {
      location: "https://github.com/cli/cli/releases/tag/v2.103.3",
    });
    response.end();
  });
  // A free port nothing listens on yet: the first attempt is refused.
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${port}/latest`;
  await assert.rejects(fetchRetrying(url, {}, 1));
  setTimeout(() => server.listen(port, "127.0.0.1"), 300);
  const response = await fetchRetrying(url, { redirect: "manual" });
  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("location"),
    "https://github.com/cli/cli/releases/tag/v2.103.3",
  );
});
