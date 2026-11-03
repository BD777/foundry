// The GitHub CLI connector (connectors/github.ts, gh-install.ts): reading
// gh's login in its old and new words, the device-code sign-in it relays,
// sessions kept from the login, and installing gh from a release archive
// whose checksum is checked. No real gh or network is used.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
import {
  checksumFor,
  ghArchiveName,
  installGitHubCli,
} from "../dist/connectors/gh-install.js";

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
