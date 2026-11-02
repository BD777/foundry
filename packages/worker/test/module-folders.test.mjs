import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  auditWorker,
  workerFileOwners,
} from "../../../scripts/audit-module-boundaries.mjs";

function fixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), "fdy-module-folders-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  return root;
}

const modules = {
  platform: { dependsOn: [], folders: ["platform"] },
  session: { dependsOn: ["platform"], folders: ["session", "connectors"] },
  "native-work": { dependsOn: ["platform"], folders: ["session/native"] },
  composition: { dependsOn: "*", folders: ["daemon"], entries: ["cli"] },
};

test("the worker source tree is laid out by module folder", () => {
  assert.deepEqual(auditWorker(), []);
});

test("a file belongs to the module of its nearest folder", () => {
  const { owner, violations } = workerFileOwners(modules, [
    "cli",
    "platform/utils",
    "platform/process/group",
    "session/state",
    "session/native/claude",
    "connectors/index",
    "daemon/dispatch",
  ]);
  assert.deepEqual(violations, []);
  assert.deepEqual(Object.fromEntries(owner), {
    cli: "composition",
    "platform/utils": "platform",
    "platform/process/group": "platform",
    "session/state": "session",
    "session/native/claude": "native-work",
    "connectors/index": "session",
    "daemon/dispatch": "composition",
  });
});

test("files outside module folders, unowned folders and missing folders fail", (t) => {
  const root = fixture(t, {
    "cli.ts": "",
    "loose-helper.ts": "",
    "stray/thing.ts": "",
    "platform/utils.ts": "",
    "session/state.ts": 'import "../daemon/dispatch.js";\n',
    "daemon/dispatch.ts": 'import "../session/state.js";\n',
    "connectors/index.ts": "",
  });
  assert.deepEqual(auditWorker(modules, root).sort(), [
    "worker: loose-helper sits outside a module folder; move it into one",
    "worker: native-work folder session/native/ does not exist",
    "worker: session/state (session) imports daemon/dispatch (composition)",
    "worker: stray/thing is in stray/, which no module owns",
  ]);
});

test("a folder or entry has one owner", () => {
  assert.throws(
    () =>
      workerFileOwners(
        {
          a: { dependsOn: [], folders: ["shared"] },
          b: { dependsOn: [], folders: ["shared"] },
        },
        [],
      ),
    /shared\/ is assigned to a and b/,
  );
});
