import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  mkdirSync,
  linkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { knowledgeCommand } from "../dist/knowledge/files.js";
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "knowledge-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = {
    workspaceId: "ws",
    rootPath: "memory",
    vaultId: "vault",
    epoch: 1,
    operationId: "init",
    action: "initialize",
  };
  const run = (change) => knowledgeCommand(root, { ...base, ...change });
  run({});
  return { root, run };
}
test("source CAS, replay, correction and durable forgetting", (t) => {
  const { root, run } = fixture(t);
  const write = {
    action: "write",
    operationId: "write1",
    documentId: "background",
    expectedRevision: 0,
    body: "Synthetic background",
    sourceRef: "session:synthetic",
  };
  const first = run(write).document;
  assert.equal(first.revision, 1);
  assert.equal(run(write).document.revision, 1);
  assert.throws(() => run({ ...write, body: "Changed" }), {
    code: "idempotency_conflict",
  });
  assert.throws(() => run({ ...write, operationId: "write2" }), {
    code: "revision_conflict",
  });
  const second = run({
    ...write,
    operationId: "write2",
    expectedRevision: 1,
    expectedHash: first.hash,
    body: "Corrected synthetic background",
  }).document;
  assert.equal(second.revision, 2);
  const forgotten = run({
    action: "forget",
    operationId: "forget1",
    documentId: first.id,
    expectedRevision: 2,
    expectedHash: second.hash,
  }).document;
  assert.equal(forgotten.body, "");
  assert.equal(forgotten.sourceRef, "");
  assert.equal(forgotten.deleted, true);
  assert.equal(
    run({ action: "forget", operationId: "forget1", documentId: first.id })
      .document.revision,
    3,
  );
  assert.doesNotMatch(
    readFileSync(join(root, "memory/background.md"), "utf8"),
    /Synthetic|Corrected|session:synthetic/,
  );
  assert.throws(
    () =>
      run({
        ...write,
        operationId: "relearn",
        expectedRevision: 3,
        expectedHash: forgotten.hash,
      }),
    { code: "forgotten" },
  );
});
test("frozen roots fence writes; staged destination and retired source stay distinct", (t) => {
  const { run } = fixture(t);
  run({
    action: "freeze",
    operationId: "migration1",
    expectedControlRevision: 1,
  });
  assert.throws(
    () =>
      run({
        action: "write",
        operationId: "late",
        documentId: "one",
        expectedRevision: 0,
        body: "late",
        sourceRef: "user",
      }),
    { code: "frozen" },
  );
  assert.throws(() => run({ action: "read", epoch: 2, documentId: "one" }), {
    code: "fenced",
  });
  run({
    action: "retire",
    operationId: "migration1-retire",
    expectedControlRevision: 2,
  });
  assert.throws(
    () =>
      run({
        action: "activate",
        operationId: "resurrect",
        expectedControlRevision: 3,
      }),
    {
      code: "invalid_state",
    },
  );
  assert.equal(
    run({ rootPath: "destination", epoch: 2, staged: true }).state,
    "staged",
  );
  assert.equal(
    run({
      rootPath: "destination",
      epoch: 2,
      action: "activate",
      operationId: "switch",
      expectedControlRevision: 1,
    }).state,
    "active",
  );
});
test("untrusted paths, links and manual content changes are refused", (t) => {
  const { root, run } = fixture(t);
  mkdirSync(join(root, "outside"));
  symlinkSync(join(root, "outside"), join(root, "alias"));
  assert.throws(() => run({ rootPath: "../escape" }), { code: "invalid_path" });
  assert.throws(() => run({ rootPath: "alias" }), { code: "unsafe_path" });
  assert.throws(() => run({ action: "read", documentId: "../outside" }), {
    code: "invalid_id",
  });
  const doc = run({
    action: "write",
    operationId: "write",
    documentId: "one",
    expectedRevision: 0,
    body: "Original",
    sourceRef: "user",
  }).document;
  const path = join(root, "memory/one.md");
  const contents = readFileSync(path, "utf8");
  writeFileSync(path, contents.replace("Original", "Outside edit"));
  assert.throws(() => run({ action: "read", documentId: doc.id }), {
    code: "external_edit",
  });
  writeFileSync(path, contents);
  linkSync(path, join(root, "outside/hardlink"));
  assert.throws(() => run({ action: "read", documentId: doc.id }), {
    code: "unsafe_path",
  });
});

test("migration preserves source versions and forgetting wins over late copies", (t) => {
  const { run } = fixture(t);
  let source = run({
    action: "write",
    operationId: "first",
    documentId: "fact",
    expectedRevision: 0,
    body: "Synthetic record",
    sourceRef: "user-input:test",
  }).document;
  source = run({
    action: "write",
    operationId: "correction",
    documentId: "fact",
    expectedRevision: 1,
    expectedHash: source.hash,
    body: "Corrected synthetic record",
    sourceRef: "user-input:correction",
  }).document;
  run({ action: "freeze", operationId: "freeze", expectedControlRevision: 1 });
  const destination = { rootPath: "new-root", epoch: 2 };
  run({ ...destination, staged: true });
  assert.throws(
    () =>
      run({
        ...destination,
        action: "write",
        operationId: "ordinary-write",
        documentId: "other",
        expectedRevision: 0,
        body: "no",
        sourceRef: "user",
      }),
    { code: "frozen" },
  );
  const copy = run({
    ...destination,
    action: "import",
    operationId: "copy",
    documentId: "fact",
    importDocument: source,
  }).document;
  assert.equal(copy.revision, 2);
  assert.equal(copy.hash, source.hash);
  assert.equal(copy.sourceRef, source.sourceRef);
  const forgotten = run({
    action: "forget",
    operationId: "forget",
    documentId: "fact",
    expectedRevision: 2,
    expectedHash: source.hash,
  }).document;
  run({
    ...destination,
    action: "import",
    operationId: "copy-forgotten",
    documentId: "fact",
    importDocument: forgotten,
  });
  assert.throws(
    () =>
      run({
        ...destination,
        action: "import",
        operationId: "late-copy",
        documentId: "fact",
        importDocument: source,
      }),
    { code: "forgotten" },
  );
  run({
    ...destination,
    action: "activate",
    operationId: "activate",
    expectedControlRevision: 1,
  });
  run({ action: "retire", operationId: "retire", expectedControlRevision: 2 });
  const erased = run({
    action: "forget",
    operationId: "replica-forget",
    documentId: "fact",
    expectedRevision: forgotten.revision,
    expectedHash: forgotten.hash,
  }).document;
  assert.equal(erased.deleted, true);
  assert.equal(erased.body, "");
});
test("a cancelled freeze cannot arrive late and freeze the recovered source", (t) => {
  const { run } = fixture(t);
  run({ action: "freeze", operationId: "freeze", expectedControlRevision: 1 });
  run({
    action: "activate",
    operationId: "cancel",
    expectedControlRevision: 2,
  });
  assert.throws(
    () =>
      run({
        action: "freeze",
        operationId: "freeze",
        expectedControlRevision: 1,
      }),
    { code: "control_revision_conflict" },
  );
  assert.equal(run({ action: "status" }).state, "active");
  // Cancellation before freeze delivery also advances the control fence.
  run({
    action: "activate",
    operationId: "cancel-before-delivery",
    expectedControlRevision: 3,
  });
  assert.throws(
    () =>
      run({
        action: "freeze",
        operationId: "late-freeze",
        expectedControlRevision: 3,
      }),
    { code: "control_revision_conflict" },
  );
});

test("manual source changes require review hash, can be adopted, and remain forgettable", (t) => {
  const { root, run } = fixture(t);
  const first = run({
    action: "write",
    operationId: "source",
    documentId: "fact",
    expectedRevision: 0,
    body: "Original",
    sourceRef: "person:original",
  }).document;
  const path = join(root, "memory/fact.md");
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace("Original", "Manual correction"),
  );
  assert.throws(() => run({ action: "read", documentId: "fact" }), {
    code: "external_edit",
  });
  const review = run({ action: "inspect", documentId: "fact" }).review;
  assert.equal(review.body, "Manual correction");
  const adopt = {
    action: "adopt",
    operationId: "adopt1",
    documentId: "fact",
    expectedRevision: 1,
    expectedHash: first.hash,
    expectedRawHash: review.rawHash,
    body: review.body,
    sourceRef: "user-review:synthetic",
    sourceVersion: review.rawHash,
  };
  assert.throws(() => run({ ...adopt, expectedRawHash: "0".repeat(64) }), {
    code: "external_edit",
  });
  const second = run(adopt).document;
  assert.equal(second.revision, 2);
  assert.equal(run(adopt).document.revision, 2);
  writeFileSync(path, "Changed without a header");
  const changed = run({ action: "inspect", documentId: "fact" }).review;
  const forgotten = run({
    action: "forget",
    operationId: "forget-changed",
    documentId: "fact",
    expectedRevision: 2,
    expectedHash: second.hash,
    expectedRawHash: changed.rawHash,
  }).document;
  assert.equal(forgotten.deleted, true);
  assert.doesNotMatch(readFileSync(path, "utf8"), /Changed|Manual|Original/);
  assert.throws(
    () =>
      run({
        ...adopt,
        operationId: "revive",
        expectedRevision: 3,
        expectedHash: forgotten.hash,
        expectedRawHash: run({ action: "inspect", documentId: "fact" }).review
          .rawHash,
      }),
    { code: "forgotten" },
  );
});
test("journaled abandoned temp is removed without sweeping unknown files", (t) => {
  const { root, run } = fixture(t);
  const folder = join(root, "memory");
  const name = ".pending-12345678-1234-1234-1234-123456789abc";
  writeFileSync(join(folder, name), "uncommitted private fragment");
  writeFileSync(
    join(folder, ".pending-journal.json"),
    JSON.stringify({ name, pid: process.pid }),
  );
  writeFileSync(join(folder, ".pending-user-note"), "leave this alone");
  run({ action: "status" });
  assert.throws(() => readFileSync(join(folder, name)), { code: "ENOENT" });
  assert.equal(
    readFileSync(join(folder, ".pending-user-note"), "utf8"),
    "leave this alone",
  );
});
