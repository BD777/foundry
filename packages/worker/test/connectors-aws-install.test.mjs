import assert from "node:assert/strict";
import test from "node:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  awsInstallPaths,
  installAwsCli,
} from "../dist/connectors/aws-install.js";
import { DeviceHeldConnectors } from "../dist/connectors/device-held.js";
import { hideHostTools } from "./fixtures/host-tools.mjs";

hideHostTools(["aws"]);

const fingerprint = "FB5DB77FD5C118B80511ADA8A6310ACC4672475C";
const descriptor = JSON.parse(
  readFileSync(
    new URL(
      "../../../apps/server/internal/connectors/catalog.json",
      import.meta.url,
    ),
  ),
).find((x) => x.kind === "aws");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "fdy-aws-install-"));
  const home = join(root, "home");
  const managedBin = join(root, "tools", "bin");
  mkdirSync(home, { recursive: true });
  return { root, home, managedBin };
}

/**
 * A fake device: records every program run, plays AWS's installers (they
 * create the files the real ones do) and answers `aws --version`.
 */
function device(home, overrides = {}) {
  const calls = [];
  const downloads = [];
  const { installDir, binDir } = awsInstallPaths(home);
  const run = async (command, args) => {
    calls.push([command, ...args]);
    const name = command.split("/").pop();
    if (overrides[name]) return overrides[name](args);
    if (name === "gpg")
      return {
        code: 0,
        stdout: args.includes("--verify")
          ? `[GNUPG:] GOODSIG A6310ACC4672475C AWS CLI Team\n[GNUPG:] VALIDSIG 0 2026-10-01 1 0 4 0 1 10 01 ${fingerprint}\n`
          : "",
        stderr: "",
      };
    if (name === "unzip") {
      mkdirSync(join(args[3], "aws"), { recursive: true });
      return { code: 0, stdout: "", stderr: "" };
    }
    if (command.endsWith("/aws/install")) {
      const program = join(installDir, "v2", "current", "bin", "aws");
      mkdirSync(dirname(program), { recursive: true });
      writeFileSync(program, "#!/bin/sh\n", { mode: 0o755 });
      mkdirSync(binDir, { recursive: true });
      rmSync(join(binDir, "aws"), { force: true });
      symlinkSync(program, join(binDir, "aws"));
      return { code: 0, stdout: "You can now run: aws --version", stderr: "" };
    }
    if (name === "pkgutil")
      return {
        code: 0,
        stdout:
          "Status: signed by a developer certificate issued by Apple for distribution\n   1. Developer ID Installer: Amazon.com Services LLC (94KV3E626L)\n",
        stderr: "",
      };
    if (name === "installer") {
      mkdirSync(join(installDir), { recursive: true });
      writeFileSync(join(installDir, "aws"), "#!/bin/sh\n", { mode: 0o755 });
      writeFileSync(join(installDir, "aws_completer"), "", { mode: 0o755 });
      return {
        code: 0,
        stdout: "installer: The upgrade was successful.",
        stderr: "",
      };
    }
    if (command === join(binDir, "aws") && args[0] === "--version")
      return {
        code: 0,
        stdout:
          "aws-cli/2.31.20 Python/3.13.7 Linux/6.1.0 exe/x86_64.debian.12\n",
        stderr: "",
      };
    return { code: 127, stdout: "", stderr: `${command}: not found` };
  };
  const download = async (url, file) => {
    downloads.push(url);
    if (overrides.download) return overrides.download(url, file);
    writeFileSync(file, "zip");
  };
  const tools = new Set(overrides.tools ?? ["unzip", "gpg"]);
  return {
    calls,
    downloads,
    options: {
      home,
      run,
      download,
      which: (name) => (tools.has(name) ? `/usr/bin/${name}` : undefined),
    },
  };
}

test("Linux: AWS's installer runs for this user only, checked and linked for sessions", async () => {
  const { root, home, managedBin } = fixture();
  try {
    const fake = device(home);
    const result = await installAwsCli({
      ...fake.options,
      managedBin,
      platform: "linux",
      arch: "x64",
    });
    assert.deepEqual(fake.downloads, [
      "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip",
      "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip.sig",
    ]);
    const install = fake.calls.find(([command]) =>
      command.endsWith("/aws/install"),
    );
    assert.deepEqual(install.slice(1), [
      "--install-dir",
      join(home, ".local", "share", "aws-cli"),
      "--bin-dir",
      join(home, ".local", "bin"),
    ]);
    assert.ok(
      fake.calls.every(([command]) => command !== "sudo"),
      "never sudo",
    );
    assert.ok(
      fake.calls.some(
        ([command, ...args]) =>
          command === "/usr/bin/gpg" && args.includes("--verify"),
      ),
    );
    assert.equal(result.version, "2.31.20");
    assert.equal(
      readlinkSync(join(managedBin, "aws")),
      join(home, ".local", "bin", "aws"),
    );
    // The scratch folder with the download is gone.
    assert.ok(
      !fake.calls
        .filter(([command]) => command === "/usr/bin/unzip")
        .some(([, , zip]) => existsSync(zip)),
    );

    // A second install updates the same copy.
    const again = device(home);
    await installAwsCli({
      ...again.options,
      managedBin,
      platform: "linux",
      arch: "arm64",
    });
    assert.equal(
      again.downloads[0],
      "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip",
    );
    assert.ok(
      again.calls
        .find(([command]) => command.endsWith("/aws/install"))
        .includes("--update"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Linux: a bad signature or a missing unzip stops before anything is installed", async () => {
  const { root, home, managedBin } = fixture();
  try {
    const forged = device(home, {
      gpg: (args) => ({
        code: args.includes("--verify") ? 1 : 0,
        stdout: args.includes("--verify")
          ? "[GNUPG:] BADSIG A6310ACC4672475C AWS CLI Team\n"
          : "",
        stderr: "",
      }),
    });
    await assert.rejects(
      installAwsCli({
        ...forged.options,
        managedBin,
        platform: "linux",
        arch: "x64",
      }),
      /does not carry AWS's signature; nothing was installed/,
    );
    assert.ok(!forged.calls.some(([command]) => command.endsWith("/install")));

    const bare = device(home, { tools: ["gpg"] });
    await assert.rejects(
      installAwsCli({
        ...bare.options,
        managedBin,
        platform: "linux",
        arch: "x64",
      }),
      /needs unzip/,
    );
    assert.deepEqual(bare.downloads, []);

    // Without gpg the HTTPS download alone is used, as AWS's guide allows.
    const nogpg = device(home, { tools: ["unzip"] });
    await installAwsCli({
      ...nogpg.options,
      managedBin,
      platform: "linux",
      arch: "x64",
    });
    assert.equal(nogpg.downloads.length, 1);
    assert.ok(existsSync(join(managedBin, "aws")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a download or installer failure is one readable reason; another AWS CLI is never replaced", async () => {
  const { root, home, managedBin } = fixture();
  try {
    const offline = device(home, {
      download: async (url) => {
        throw new Error(
          `could not download ${url}: connect ECONNREFUSED 127.0.0.1:9`,
        );
      },
    });
    await assert.rejects(
      installAwsCli({
        ...offline.options,
        managedBin,
        platform: "linux",
        arch: "x64",
      }),
      /could not download https:\/\/awscli\.amazonaws\.com\/awscli-exe-linux-x86_64\.zip: connect ECONNREFUSED/,
    );
    const failing = device(home);
    const run = failing.options.run;
    failing.options.run = async (command, args) =>
      command.endsWith("/aws/install")
        ? {
            code: 1,
            stdout: "",
            stderr: "\nFound preexisting AWS CLI installation\nmore\n",
          }
        : run(command, args);
    await assert.rejects(
      installAwsCli({
        ...failing.options,
        managedBin,
        platform: "linux",
        arch: "x64",
      }),
      /^Error: AWS's installer failed: Found preexisting AWS CLI installation$/,
    );
    assert.ok(!existsSync(join(managedBin, "aws")));

    // pip's AWS CLI v1 in ~/.local/bin is the person's to remove.
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(join(home, ".local", "bin", "aws"), "#!/usr/bin/python3\n");
    const pip = device(home);
    await assert.rejects(
      installAwsCli({
        ...pip.options,
        managedBin,
        platform: "linux",
        arch: "x64",
      }),
      /~\/\.local\/bin\/aws is another AWS CLI\. Remove it/,
    );
    assert.deepEqual(pip.downloads, []);
    assert.ok(lstatSync(join(home, ".local", "bin", "aws")).isFile());

    await assert.rejects(
      installAwsCli({
        ...device(home).options,
        managedBin,
        platform: "win32",
        arch: "x64",
        home: join(root, "other"),
      }),
      /Linux and macOS/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("macOS: the signed pkg installs for the current user, linked like AWS documents", async () => {
  const { root, home, managedBin } = fixture();
  try {
    const fake = device(home);
    let choices = "";
    const run = fake.options.run;
    fake.options.run = async (command, args) => {
      if (command === "/usr/sbin/installer")
        choices = readFileSync(
          args[args.indexOf("-applyChoiceChangesXML") + 1],
          "utf8",
        );
      return run(command, args);
    };
    await installAwsCli({
      ...fake.options,
      managedBin,
      platform: "darwin",
      arch: "arm64",
    });
    assert.deepEqual(fake.downloads, [
      "https://awscli.amazonaws.com/AWSCLIV2.pkg",
    ]);
    const installer = fake.calls.find(
      ([command]) => command === "/usr/sbin/installer",
    );
    assert.equal(
      installer[installer.indexOf("-target") + 1],
      "CurrentUserHomeDirectory",
    );
    assert.match(choices, /<string>customLocation<\/string>/);
    assert.ok(
      choices.includes(`<string>${join(home, ".local", "share")}</string>`),
    );
    const { installDir, binDir } = awsInstallPaths(home);
    assert.equal(readlinkSync(join(binDir, "aws")), join(installDir, "aws"));
    assert.equal(
      readlinkSync(join(binDir, "aws_completer")),
      join(installDir, "aws_completer"),
    );

    const unsigned = device(home, {
      pkgutil: () => ({ code: 1, stdout: "Status: no signature", stderr: "" }),
    });
    await assert.rejects(
      installAwsCli({
        ...unsigned.options,
        managedBin,
        platform: "darwin",
        arch: "arm64",
      }),
      /not signed by Amazon/,
    );
    assert.ok(
      !unsigned.calls.some(([command]) => command === "/usr/sbin/installer"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an installer connector installs through its adapter, then reads the result", async () => {
  const { root, managedBin } = fixture();
  try {
    const installed = [];
    const adapter = {
      name: "aws",
      runEnvironment: {},
      clearEnvironment: [],
      async install(bin) {
        installed.push(bin);
        mkdirSync(bin, { recursive: true });
        writeFileSync(
          join(bin, "aws"),
          "#!/bin/sh\necho aws-cli/2.31.20 Python/3.13.7\n",
          { mode: 0o755 },
        );
      },
      readVersion: async (run) =>
        /aws-cli\/(\S+)/.exec((await run(["--version"])).stdout)?.[1],
      readLogin: async () => ({ signedIn: false }),
      beginSignIn: async () => ({ status: "failed" }),
      pollSignIn: async () => ({ status: "failed" }),
      signOut: async () => {},
      sessionNote: () => "",
    };
    const connectors = new DeviceHeldConnectors({
      adapters: { aws: adapter },
      managedBin: () => managedBin,
      toolDirs: [],
    });
    const reply = await connectors.handle({
      action: "install",
      connector: descriptor,
    });
    assert.equal(reply.error, undefined);
    assert.deepEqual(installed, [managedBin]);
    assert.equal(reply.state.status, "signed_out");
    assert.equal(reply.state.installSource, "foundry");
    assert.equal(reply.state.version, "2.31.20");

    const old = new DeviceHeldConnectors({
      adapters: { aws: { ...adapter, install: undefined } },
      managedBin: () => join(root, "empty"),
      toolDirs: [],
    });
    assert.match(
      (await old.handle({ action: "install", connector: descriptor })).error,
      /cannot install AWS CLI; update the worker/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
