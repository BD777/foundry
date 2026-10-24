// Connector lookup searches node's folder, then PATH, then its own tool
// folders, so a CLI installed on the host (CI images ship aws) would win over
// a test's fake. hideHostTools points PATH at an empty folder for the file's
// tests and restores it afterwards.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before } from "node:test";

export function hideHostTools(commands) {
  let hostPath;
  let empty;
  before(() => {
    // node's own folder is searched before PATH and cannot be hidden.
    for (const command of commands)
      assert.ok(
        !existsSync(join(dirname(process.execPath), command)),
        `${command} sits beside node (${process.execPath}); these tests need a node install without it`,
      );
    hostPath = process.env.PATH;
    empty = mkdtempSync(join(tmpdir(), "fdy-no-tools-"));
    process.env.PATH = empty;
  });
  after(() => {
    process.env.PATH = hostPath;
    rmSync(empty, { force: true, recursive: true });
  });
}
