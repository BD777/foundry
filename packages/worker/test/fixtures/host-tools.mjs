// Connector lookup searches node's folder, then PATH, then its own tool
// folders, so a CLI installed on the host (CI images ship aws) would win over
// a test's fake. hideHostTools points both at a disposable folder for the
// file's tests and restores them afterwards.
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before } from "node:test";

export function hideHostTools(commands) {
  let hostPath;
  let empty;
  let hostExecPath;
  before(() => {
    hostPath = process.env.PATH;
    hostExecPath = process.execPath;
    empty = mkdtempSync(join(tmpdir(), "fdy-no-tools-"));
    const node = join(empty, "node");
    symlinkSync(hostExecPath, node);
    process.execPath = node;
    process.env.PATH = empty;
  });
  after(() => {
    if (hostExecPath) process.execPath = hostExecPath;
    if (hostPath !== undefined) process.env.PATH = hostPath;
    else delete process.env.PATH;
    if (empty) rmSync(empty, { force: true, recursive: true });
  });
}
