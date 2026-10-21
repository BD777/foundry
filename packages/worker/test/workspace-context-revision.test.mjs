import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  statSync,
  utimesSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  instructionFileRevision,
  workspaceInstructionRevision,
} from "../dist/workspace-context-revision.js";
import { WorkspaceRoster } from "../dist/daemon/workspace-roster.js";

function folder(t) {
  const root = mkdtempSync(join(tmpdir(), "context-revision-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
test("same-size context edits are detected even when mtime is preserved; unchanged content stays stable", (t) => {
  const root = folder(t),
    path = join(root, "AGENTS.md");
  writeFileSync(path, "Use Chinese.");
  const before = statSync(path),
    a = workspaceInstructionRevision(root);
  writeFileSync(path, "Use English.");
  utimesSync(path, before.atime, before.mtime);
  const b = workspaceInstructionRevision(root);
  assert.notEqual(a, b);
  assert.equal(workspaceInstructionRevision(root), b);
  utimesSync(path, new Date(), new Date());
  assert.equal(workspaceInstructionRevision(root), b);
  writeFileSync(join(root, "unrelated.txt"), "new");
  assert.equal(workspaceInstructionRevision(root), b);
});
test("context fingerprints do not follow links or read unbounded documents", (t) => {
  const root = folder(t);
  writeFileSync(join(root, "outside"), "synthetic body");
  symlinkSync(join(root, "outside"), join(root, "AGENTS.md"));
  const a = instructionFileRevision(root, "AGENTS.md");
  assert.match(a, /^link:/);
  writeFileSync(join(root, "outside"), "changed private body");
  assert.equal(instructionFileRevision(root, "AGENTS.md"), a);
  writeFileSync(join(root, "README.md"), Buffer.alloc(256 * 1024 + 1));
  assert.match(instructionFileRevision(root, "README.md"), /^oversized:/);
});
test("the existing workspace timer reports context changes once without a model call or native-chat change", (t) => {
  const root = folder(t),
    path = join(root, "README.md");
  writeFileSync(path, "One.");
  const sent = [];
  const roster = new WorkspaceRoster(
    { readyState: 1, send: (text) => sent.push(JSON.parse(text)) },
    "",
    { activeSessionIds: () => [] },
  );
  roster.registration = () => ({
    device: { id: "device" },
    workspace: { id: "workspace", localPath: root },
    workspaceFiles: [
      {
        path: "README.md",
        revision: instructionFileRevision(root, "README.md"),
      },
    ],
  });
  roster.register(roster.registration());
  roster.checkContextFiles();
  assert.equal(sent.length, 0);
  writeFileSync(path, "Two.");
  roster.checkContextFiles();
  assert.equal(sent.length, 1);
  assert.match(
    sent[0].payload.registration.workspaceFiles[0].revision,
    /^sha256:/,
  );
  roster.checkContextFiles();
  assert.equal(sent.length, 1);
  roster.close();
  writeFileSync(path, "New.");
  roster.checkContextFiles();
  assert.equal(sent.length, 1);
});
