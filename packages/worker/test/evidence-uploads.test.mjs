import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ExecutionStore } from "../dist/execution-storage.js";
import { EvidenceStore } from "../dist/evidence-store.js";
import { evidenceWorkerAction } from "../dist/evidence-rpc.js";
import {
  appendEvidenceUpload,
  expireIncompleteUploads,
} from "../dist/evidence-uploads.js";

function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), "foundry-upload-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const execution = new ExecutionStore(root);
  const store = new EvidenceStore(
    "ws",
    "issue",
    "dev",
    { kind: "daemon", id: "dev", displayName: "Worker" },
    execution,
  );
  return { root, store, execution };
}

test("completed uploads replay against sealed bytes after temporary upload is removed", async (t) => {
  const { store, execution } = fixture(t);
  const base = {
    workspaceId: "ws",
    issueId: "issue",
    deviceId: "dev",
    taskId: "task_upload",
  };
  const chunk = {
    ...base,
    action: "upload_chunk",
    offset: 0,
    bytesBase64: Buffer.from("original").toString("base64"),
  };
  const seal = {
    ...base,
    action: "upload_seal",
    name: "text.txt",
    carrier: "document",
    byteSize: 8,
    actor: { kind: "local_owner", id: "owner", displayName: "Owner" },
  };
  await evidenceWorkerAction(chunk, execution);
  const receipt = await evidenceWorkerAction(seal, execution);
  assert.equal(receipt.error, undefined);
  assert.equal(
    existsSync(resolve(store.root, "outbox/task_upload.upload")),
    false,
  );
  await evidenceWorkerAction(chunk, execution);
  assert.equal(
    (await evidenceWorkerAction(seal, execution)).materials[0].id,
    receipt.materials[0].id,
  );
  assert.equal(
    existsSync(resolve(store.root, "outbox/task_upload.upload")),
    false,
  );
  await assert.rejects(
    evidenceWorkerAction(
      { ...chunk, bytesBase64: Buffer.from("different").toString("base64") },
      execution,
    ),
    /idempotency_conflict/,
  );
  assert.equal(
    store.readMaterial(receipt.materials[0].id).toString(),
    "original",
  );
});

test("24-hour upload expiry is Issue-scoped and never deletes sealed material or uncertain seal input", (t) => {
  const { store, execution } = fixture(t);
  const encoded = Buffer.from("retained").toString("base64");
  appendEvidenceUpload(store, "expired", 0, encoded);
  appendEvidenceUpload(store, "uncertain", 0, encoded);
  writeFileSync(resolve(store.root, "outbox/uncertain.intent.json"), "{}");
  const other = new EvidenceStore("ws", "other", "dev", store.actor, execution);
  appendEvidenceUpload(other, "foreign", 0, encoded);
  const material = store.sealMaterial(
    "actual",
    "document",
    Buffer.from("retained"),
  );
  expireIncompleteUploads(store, Date.now() + 23 * 3600000);
  assert.equal(existsSync(resolve(store.root, "outbox/expired.upload")), true);
  expireIncompleteUploads(store, Date.now() + 25 * 3600000);
  assert.equal(existsSync(resolve(store.root, "outbox/expired.upload")), false);
  assert.equal(
    existsSync(resolve(store.root, "outbox/expired.upload.json")),
    false,
  );
  assert.equal(existsSync(resolve(store.root, "outbox/foreign.upload")), true);
  assert.equal(
    existsSync(resolve(store.root, "outbox/uncertain.upload")),
    true,
  );
  assert.equal(store.readMaterial(material.id).toString(), "retained");
});

test("upload cache rejects symlinks and malformed base64", (t) => {
  const { root, store } = fixture(t);
  const outside = resolve(root, "outside");
  writeFileSync(outside, "unchanged");
  symlinkSync(outside, resolve(store.root, "outbox/symlink.upload"));
  assert.throws(
    () => appendEvidenceUpload(store, "symlink", 0, "eA=="),
    /unsafe_upload_file/,
  );
  assert.throws(
    () => appendEvidenceUpload(store, "invalid", 0, "%%%"),
    /invalid_upload_encoding/,
  );
  assert.equal(readFileSync(outside, "utf8"), "unchanged");
  const absent = resolve(root, "absent");
  symlinkSync(absent, resolve(store.root, "outbox/dangling.upload"));
  assert.throws(
    () => appendEvidenceUpload(store, "dangling", 0, "eA=="),
    /unsafe_upload_file/,
  );
  assert.equal(existsSync(absent), false);
});
