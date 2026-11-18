import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { runtimeRoot } from "../dist/install/worker-identity.js";
import {
  foundryCommandPath,
  installFoundryCommand,
  linkCommand,
} from "../dist/install/foundry-command.js";

const skipUnlessPosix = {
  skip: process.platform !== "darwin" && process.platform !== "linux",
};

function scratchDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "foundry-command-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function foundryWrapper() {
  return "#!/bin/sh\n# Foundry CLI on this machine; written by install and update.\nexit 0\n";
}

test(
  "foundry is linked into a directory on PATH, and a second link changes nothing",
  skipUnlessPosix,
  (t) => {
    const dir = scratchDirectory(t);
    const command = join(dir, "wrapper");
    writeFileSync(command, foundryWrapper());
    const local = join(dir, "local-bin");
    mkdirSync(local);
    const pathEnv = ["/usr/bin", local].join(delimiter);
    const link = join(local, "foundry");

    assert.deepEqual(
      linkCommand(command, { name: "foundry", directory: local, pathEnv }),
      { status: "linked", link },
    );
    assert.equal(readlinkSync(link), command);
    assert.deepEqual(
      linkCommand(command, { name: "foundry", directory: local, pathEnv }),
      { status: "unchanged", link },
    );
  },
);

test(
  "foundry is not linked into a directory that is off PATH or missing",
  skipUnlessPosix,
  (t) => {
    const dir = scratchDirectory(t);
    const command = join(dir, "wrapper");
    writeFileSync(command, foundryWrapper());
    const local = join(dir, "local-bin");
    mkdirSync(local);

    assert.deepEqual(
      linkCommand(command, {
        name: "foundry",
        directory: local,
        pathEnv: "/usr/bin:/bin",
      }),
      { status: "off-path", directory: local },
    );
    const missing = join(dir, "no-such-dir");
    assert.deepEqual(
      linkCommand(command, {
        name: "foundry",
        directory: missing,
        pathEnv: missing,
      }),
      { status: "absent", directory: missing },
    );
    assert.equal(existsSync(join(local, "foundry")), false);
  },
);

test(
  "another program's foundry is left alone; a Foundry wrapper or link to another one is replaced",
  skipUnlessPosix,
  (t) => {
    const dir = scratchDirectory(t);
    const command = join(dir, "wrapper");
    writeFileSync(command, foundryWrapper());
    const local = join(dir, "local-bin");
    mkdirSync(local);
    const pathEnv = local;
    const link = join(local, "foundry");
    const options = { name: "foundry", directory: local, pathEnv };

    writeFileSync(link, "#!/bin/sh\necho another program\n", { mode: 0o755 });
    assert.deepEqual(linkCommand(command, options), {
      status: "occupied",
      link,
    });
    assert.equal(
      readFileSync(link, "utf8"),
      "#!/bin/sh\necho another program\n",
    );

    rmSync(link);
    const otherTool = join(dir, "other-tool");
    writeFileSync(otherTool, "#!/bin/sh\necho other tool\n");
    symlinkSync(otherTool, link);
    assert.deepEqual(linkCommand(command, options), {
      status: "occupied",
      link,
    });
    assert.equal(readlinkSync(link), otherTool);

    rmSync(link);
    writeFileSync(link, foundryWrapper());
    assert.deepEqual(linkCommand(command, options), { status: "linked", link });
    assert.equal(readlinkSync(link), command);
  },
);

test(
  "install writes foundry, which runs the installed runtime's CLI, and links it when ~/.local/bin is on PATH",
  skipUnlessPosix,
  (t) => {
    const dir = scratchDirectory(t);
    const cli = join(
      runtimeRoot(),
      "current",
      "node_modules",
      "fake-foundry",
      "dist",
      "foundry-cli.js",
    );
    mkdirSync(dirname(cli), { recursive: true });
    writeFileSync(cli, "console.log(JSON.stringify(process.argv.slice(2)));");
    const local = join(dir, "local-bin");
    mkdirSync(local);

    const lines = installFoundryCommand("fake-foundry", {
      node: process.execPath,
      localBin: local,
      pathEnv: local,
    });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /foundry is on PATH/);
    assert.equal(readlinkSync(join(local, "foundry")), foundryCommandPath());

    const out = JSON.parse(
      execFileSync(join(local, "foundry"), ["session", "list"], {
        encoding: "utf8",
        env: { PATH: process.env.PATH },
      }),
    );
    assert.deepEqual(out, ["session", "list"]);
    t.after(() => rmSync(foundryCommandPath(), { force: true }));
  },
);

test(
  "install without ~/.local/bin on PATH writes foundry and says where it is",
  skipUnlessPosix,
  (t) => {
    const dir = scratchDirectory(t);
    const local = join(dir, "local-bin");
    mkdirSync(local);
    const lines = installFoundryCommand("fake-foundry", {
      node: process.execPath,
      localBin: local,
      pathEnv: "/usr/bin:/bin",
    });
    assert.equal(existsSync(join(local, "foundry")), false);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /not on PATH/);
    assert.match(lines[0], /foundry is at /);
    assert.ok(existsSync(foundryCommandPath()));
    t.after(() => rmSync(foundryCommandPath(), { force: true }));
  },
);

test(
  "install leaves another program at foundry's own path alone",
  skipUnlessPosix,
  (t) => {
    const path = foundryCommandPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "#!/bin/sh\necho not foundry\n", { mode: 0o755 });
    t.after(() => rmSync(path, { force: true }));
    const dir = scratchDirectory(t);
    const lines = installFoundryCommand("fake-foundry", {
      node: process.execPath,
      localBin: dir,
      pathEnv: dir,
    });
    assert.match(lines[0], /not a Foundry command; left it alone/);
    assert.equal(readFileSync(path, "utf8"), "#!/bin/sh\necho not foundry\n");
    assert.equal(existsSync(join(dir, "foundry")), false);
  },
);
