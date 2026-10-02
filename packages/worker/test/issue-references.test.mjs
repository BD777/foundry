import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionStore } from "../dist/execution-storage.js";
import { EvidenceStore } from "../dist/evidence-store.js";
import { issueReferences } from "../dist/issue-references.js";
import { crc32, deflateSync } from "node:zlib";

function solidPng(width, height, rgb) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array(width).fill(rgb).flat()),
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array(height).fill(row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("the execution gets the contract's references as read-only files", () => {
  const root = mkdtempSync(join(tmpdir(), "issue-references-"));
  const execution = new ExecutionStore(join(root, "state"));
  const store = new EvidenceStore(
    "ws_r",
    "iss_r",
    "dev",
    { kind: "daemon", id: "dev", displayName: "Worker" },
    execution,
  );
  const png = solidPng(4, 4, [220, 30, 40]);
  const image = store.sealMaterial("reference.png", "image", png);
  const notes = store.sealMaterial(
    "notes.txt",
    "document",
    Buffer.from("tone: friendly"),
  );
  const environment = {
    workspaceId: "ws_r",
    issueId: "iss_r",
    directory: join(root, "env"),
  };
  const media = (id, caption) => ({ materialId: id, role: "context", caption });
  const issue = {
    executionContract: {
      goal: { text: "Match it", media: [media(image.id, "reference.png")] },
      criteria: [
        {
          rubric: {
            text: "",
            media: [media(image.id, "reference.png"), media(notes.id, "notes")],
          },
        },
      ],
    },
  };
  const references = issueReferences(environment, issue, execution);
  assert.equal(references.length, 2, "each material once");
  const [first, second] = references;
  assert.equal(first.kind, "image");
  assert.equal(first.mimeType, image.mimeType);
  assert.deepEqual(readFileSync(first.path), png);
  assert.equal(statSync(first.path).mode & 0o222, 0, "read-only");
  assert.equal(second.kind, "file");
  assert.equal(readFileSync(second.path, "utf8"), "tone: friendly");
  assert.deepEqual(
    issueReferences(environment, { executionContract: undefined }, execution),
    [],
  );
});
