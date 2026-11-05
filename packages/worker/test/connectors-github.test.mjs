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
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  githubAdapter,
  grantedScopes,
  parseGhAuthStatus,
  parseGhDeviceCode,
  parseGhTokenScopes,
  scopeChange,
  sessionGh,
} from "../dist/connectors/github.js";
import {
  checkedSignInScopes,
  DeviceHeldConnectors,
} from "../dist/connectors/device-held.js";
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
  // gh cannot leave a login there for the next such session, and what one
  // left anyway is gone when the next starts.
  const dir = environment.GH_CONFIG_DIR;
  assert.equal(statSync(dir).mode & 0o777, 0o500);
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, "hosts.yml"), "github.com: {}\n");
  githubAdapter.isolationEnvironment();
  assert.deepEqual(readdirSync(dir), []);
});

test("sign-out falls back to one account per host on gh before 2.40", async () => {
  const calls = [];
  const run = async (args) => {
    calls.push(args.join(" "));
    if (args[1] === "status")
      return {
        code: 0,
        stdout: "",
        stderr:
          "github.com\n  ✓ Logged in to github.com as octo-cat (oauth_token)\n",
      };
    if (args.includes("--user"))
      return { code: 1, stdout: "", stderr: "unknown flag: --user" };
    return { code: 0, stdout: "", stderr: "" };
  };
  await githubAdapter.signOut(run);
  assert.deepEqual(calls.slice(-2), [
    "auth logout --hostname github.com --user octo-cat",
    "auth logout --hostname github.com",
  ]);
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
    // Staged inside the install root (a rename out of /tmp can cross
    // filesystems), and nothing staged is left behind.
    assert.deepEqual(
      readdirSync(join(home, ".local", "share", "gh-cli")).filter((name) =>
        name.startsWith(".staging-"),
      ),
      [],
    );

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

test("package capability distinguishes missing, granted and unverified scopes", async () => {
  for (const [scopes, status] of [
    ["'repo', 'read:org'", "needs_auth"],
    ["'read:packages', 'repo'", "ready"],
    ["'write:packages'", "ready"],
    ["'delete:packages'", "needs_auth"],
    [undefined, "unknown"],
  ]) {
    const run = async () => ({
      code: 0,
      stdout: "",
      stderr:
        "Logged in to github.com account octo-cat (keyring)\n" +
        (scopes === undefined ? "" : `  - Token scopes: ${scopes}\n`),
    });
    const reading = (await githubAdapter.readAuthorizations(run)).find(
      (entry) => entry.id === "packages-read",
    );
    assert.equal(reading.status, status);
  }
  const [out] = await githubAdapter.readAuthorizations(async () => ({
    code: 1,
    stdout: "",
    stderr: "not logged in",
  }));
  assert.equal(out.status, "needs_auth");
});

test("package authorization refreshes the existing login and relays the native device code", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  let identity = "octo-cat";
  let scopes = "repo";
  let args;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  const run = async () => ({
    code: 0,
    stdout: `Logged in to github.com account ${identity} (keyring)\nToken scopes: '${scopes}'`,
    stderr: "",
  });
  run.spawn = (argv) => {
    args = argv;
    setImmediate(() =>
      child.stderr.write(
        "First copy your one-time code: AB12-CD34\nOpen this URL: https://github.com/login/device\n",
      ),
    );
    return child;
  };
  const group = { id: "packages-read", revision: 1 };
  const started = await githubAdapter.beginAuthorization(run, "", group);
  assert.deepEqual(args, [
    "auth",
    "refresh",
    "--hostname",
    "github.com",
    "--scopes",
    "read:packages",
  ]);
  assert.equal(started.step.userCode, "AB12-CD34");
  assert.equal(
    (await githubAdapter.pollAuthorization(run, group, started.continuation))
      .status,
    "pending",
  );
  scopes = "read:packages";
  child.emit("exit", 0);
  assert.equal(
    (await githubAdapter.pollAuthorization(run, group, started.continuation))
      .status,
    "complete",
  );
  scopes = "repo";
  const changed = await githubAdapter.beginAuthorization(run, "", group);
  identity = "other-account";
  child.emit("exit", 0);
  assert.equal(
    (await githubAdapter.pollAuthorization(run, group, changed.continuation))
      .status,
    "failed",
  );
  await assert.rejects(
    githubAdapter.beginAuthorization(run, "", { id: "admin", revision: 1 }),
    /Unsupported/,
  );
});

const catalog = JSON.parse(
  readFileSync(
    new URL(
      "../../../apps/server/internal/connectors/catalog.json",
      import.meta.url,
    ),
  ),
);
const github = catalog.find((entry) => entry.kind === "github");
const permissions = github.authorizationGroups.find(
  (group) => group.id === "permissions",
);

test("the permissions group is GitHub's documented github.com scope list", () => {
  // docs.github.com scopes-for-oauth-apps, fpt entries (see github.ts).
  assert.deepEqual(
    permissions.scopes.map((scope) => scope.id).sort(),
    [
      "repo",
      "repo:status",
      "repo_deployment",
      "public_repo",
      "repo:invite",
      "security_events",
      "admin:repo_hook",
      "write:repo_hook",
      "read:repo_hook",
      "admin:org",
      "write:org",
      "read:org",
      "admin:public_key",
      "write:public_key",
      "read:public_key",
      "admin:org_hook",
      "gist",
      "notifications",
      "user",
      "read:user",
      "user:email",
      "user:follow",
      "project",
      "read:project",
      "delete_repo",
      "write:packages",
      "read:packages",
      "delete:packages",
      "admin:gpg_key",
      "write:gpg_key",
      "read:gpg_key",
      "codespace",
      "workflow",
      "read:audit_log",
    ].sort(),
  );
  assert.equal(permissions.scopeSource.complete, true);
  assert.equal(permissions.scopesRemovable, true);
  assert.deepEqual(
    permissions.scopes.filter((scope) => scope.required).map((s) => s.id),
    ["repo", "read:org", "gist"],
  );
  assert.ok(!permissions.scopes.some((scope) => scope.id === "offline_access"));
});

test("granted scopes include what GitHub's broadest scopes imply", () => {
  assert.deepEqual(
    parseGhTokenScopes({
      code: 0,
      stdout: "",
      stderr: "  - Token scopes: 'admin:org', 'gist', 'repo', 'user'\n",
    }),
    ["admin:org", "gist", "repo", "user"],
  );
  assert.equal(
    parseGhTokenScopes({ code: 0, stdout: "", stderr: "x" }),
    undefined,
  );
  assert.deepEqual(
    parseGhTokenScopes({ code: 0, stdout: "Token scopes: none", stderr: "" }),
    [],
  );
  const granted = grantedScopes(
    ["repo", "admin:org", "user"],
    permissions.scopes,
  );
  for (const scope of [
    "repo:status",
    "public_repo",
    "write:org",
    "read:org",
    "user:email",
  ])
    assert.ok(granted.includes(scope), scope);
  assert.ok(!granted.includes("gist"));
  assert.ok(!granted.includes("admin:public_key"));
});

test("a chosen set becomes gh's own add and remove, never dropping gh's minimum", () => {
  const raw = ["gist", "read:org", "repo", "workflow", "delete_repo"];
  assert.deepEqual(
    scopeChange(
      ["repo", "read:org", "gist", "read:packages", "workflow"],
      raw,
      permissions.scopes,
    ),
    { add: ["read:packages"], remove: ["delete_repo"] },
  );
  // A child of a held broad scope needs nothing; the minimum is never removed.
  assert.deepEqual(scopeChange(["repo:status"], raw, permissions.scopes), {
    add: [],
    remove: ["workflow", "delete_repo"],
  });
});

test("the permissions group refreshes gh with exactly the chosen changes", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  let scopes = "'gist', 'read:org', 'repo', 'delete_repo'";
  let args;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  const run = async () => ({
    code: 0,
    stdout: `Logged in to github.com account octo-cat (keyring)\nToken scopes: ${scopes}`,
    stderr: "",
  });
  run.spawn = (argv) => {
    args = argv;
    setImmediate(() =>
      child.stderr.write(
        "First copy your one-time code: AB12-CD34\nOpen this URL: https://github.com/login/device\n",
      ),
    );
    return child;
  };
  const reading = (
    await githubAdapter.readAuthorizations(
      run,
      undefined,
      github.authorizationGroups,
    )
  ).find((entry) => entry.id === "permissions");
  assert.equal(reading.status, "ready");
  assert.ok(reading.grantedScopes.includes("repo:status"));
  const started = await githubAdapter.beginAuthorization(run, "", permissions, {
    scopes: "workflow,read:packages",
  });
  assert.deepEqual(args, [
    "auth",
    "refresh",
    "--hostname",
    "github.com",
    "--scopes",
    "workflow,read:packages",
    "--remove-scopes",
    "delete_repo",
  ]);
  scopes = "'gist', 'read:org', 'repo', 'workflow'";
  child.emit("exit", 0);
  // read:packages was not granted: say so instead of claiming success.
  assert.equal(
    (
      await githubAdapter.pollAuthorization(
        run,
        permissions,
        started.continuation,
      )
    ).status,
    "failed",
  );
  await assert.rejects(
    githubAdapter.beginAuthorization(run, "", permissions, {
      scopes: "admin:enterprise",
    }),
    /Unsupported/,
  );
  // Nothing to change: complete without a GitHub round trip.
  scopes = "'gist', 'read:org', 'repo'";
  args = undefined;
  assert.equal(
    (
      await githubAdapter.beginAuthorization(run, "", permissions, {
        scopes: "repo:status",
      })
    ).step.status,
    "complete",
  );
  assert.equal(args, undefined);
});

test("sign-in takes chosen scopes only from its method's group", async () => {
  assert.deepEqual(
    checkedSignInScopes(github, {
      method: "device",
      scopes: "workflow, read:packages",
    }),
    { method: "device", scopes: "workflow,read:packages" },
  );
  assert.throws(() =>
    checkedSignInScopes(github, { method: "device", scopes: "site_admin" }),
  );
  assert.throws(() =>
    checkedSignInScopes(github, { method: "terminal", scopes: "repo" }),
  );
  assert.deepEqual(checkedSignInScopes(github, { method: "device" }), {
    method: "device",
  });
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  let args;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  const run = async () => ({ code: 1, stdout: "", stderr: "not logged in" });
  run.spawn = (argv) => {
    args = argv;
    setImmediate(() =>
      child.stderr.write(
        "First copy your one-time code: AB12-CD34\nOpen this URL: https://github.com/login/device\n",
      ),
    );
    return child;
  };
  await githubAdapter.beginSignIn(run, "", {
    method: "device",
    scopes: "repo,workflow",
  });
  assert.deepEqual(args.slice(-2), ["--scopes", "workflow"]);
  githubAdapter.cancelSignIn();
});

test("a session's gh refuses to change the device login and runs everything else", () => {
  const dir = mkdtempSync(join(tmpdir(), "gh-session-"));
  const real = join(dir, "real-gh");
  writeFileSync(real, '#!/bin/sh\necho "real gh: $*"\n', { mode: 0o700 });
  const wrapper = sessionGh(real);
  assert.equal(
    execFileSync(wrapper, [
      "auth",
      "status",
      "--hostname",
      "github.com",
    ]).toString(),
    "real gh: auth status --hostname github.com\n",
  );
  assert.equal(
    execFileSync(wrapper, ["pr", "list"]).toString(),
    "real gh: pr list\n",
  );
  for (const sub of ["login", "logout", "refresh", "switch", "setup-git"]) {
    let failure;
    try {
      execFileSync(wrapper, ["auth", sub, "-s", "workflow"], { stdio: "pipe" });
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.status, 4, sub);
    assert.match(failure.stderr.toString(), /Connectors > GitHub CLI/);
    assert.doesNotMatch(failure.stdout.toString(), /real gh/);
  }
});
