import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  abortAttachmentUpload,
  readAttachmentImageChunk,
  writeAttachmentChunk,
} from "../dist/workspace-attachments.js";

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(40, 7),
]);

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), "foundry-attachments-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("chunks land as one private file under the workspace attachments", (t) => {
  const workspacePath = workspace(t);
  const relativePath = "20260927/att_1_shot.png";
  writeAttachmentChunk({
    workspacePath,
    relativePath,
    offset: 0,
    data: png.subarray(0, 10),
    final: false,
  });
  const done = writeAttachmentChunk({
    workspacePath,
    relativePath,
    offset: 10,
    data: png.subarray(10),
    final: true,
  });
  assert.equal(
    done.path,
    join(workspacePath, ".foundry", "attachments", relativePath),
  );
  assert.equal(done.size, png.length);
  assert.deepEqual(readFileSync(done.path), png);
  assert.equal(existsSync(`${done.path}.part`), false);
  const chunk = readAttachmentImageChunk({
    workspacePath,
    path: done.path,
    offset: 0,
    maxBytes: 1024,
  });
  assert.equal(chunk.mimeType, "image/png");
  assert.equal(chunk.size, png.length);
  assert.deepEqual(chunk.data, png);
});

test("a chunk out of order is refused and the part discarded", (t) => {
  const workspacePath = workspace(t);
  writeAttachmentChunk({
    workspacePath,
    relativePath: "d/a.png",
    offset: 0,
    data: png.subarray(0, 10),
    final: false,
  });
  assert.throws(
    () =>
      writeAttachmentChunk({
        workspacePath,
        relativePath: "d/a.png",
        offset: 20,
        data: png,
        final: true,
      }),
    /does not follow/,
  );
  assert.equal(
    existsSync(
      join(workspacePath, ".foundry", "attachments", "d", "a.png.part"),
    ),
    false,
  );
  abortAttachmentUpload(workspacePath, "d/a.png");
});

test("paths outside the attachments, directly or through a link, are refused", (t) => {
  const workspacePath = workspace(t);
  assert.throws(
    () =>
      writeAttachmentChunk({
        workspacePath,
        relativePath: "../../escape.png",
        offset: 0,
        data: png,
        final: true,
      }),
    /outside/,
  );
  const outside = join(workspacePath, "outside");
  mkdirSync(outside);
  mkdirSync(join(workspacePath, ".foundry", "attachments"), {
    recursive: true,
  });
  symlinkSync(outside, join(workspacePath, ".foundry", "attachments", "link"));
  assert.throws(
    () =>
      writeAttachmentChunk({
        workspacePath,
        relativePath: "link/x.png",
        offset: 0,
        data: png,
        final: true,
      }),
    /outside/,
  );
  const secret = join(outside, "secret.png");
  writeFileSync(secret, png);
  assert.throws(
    () =>
      readAttachmentImageChunk({
        workspacePath,
        path: secret,
        offset: 0,
        maxBytes: 1024,
      }),
    /not found/,
  );
  assert.throws(
    () =>
      readAttachmentImageChunk({
        workspacePath,
        path: join(
          workspacePath,
          ".foundry",
          "attachments",
          "link",
          "secret.png",
        ),
        offset: 0,
        maxBytes: 1024,
      }),
    /not found/,
  );
});

test("only images within the size limit are served", (t) => {
  const workspacePath = workspace(t);
  const text = writeAttachmentChunk({
    workspacePath,
    relativePath: "d/note.txt",
    offset: 0,
    data: Buffer.from("hello"),
    final: true,
  });
  assert.throws(
    () =>
      readAttachmentImageChunk({
        workspacePath,
        path: text.path,
        offset: 0,
        maxBytes: 1024,
      }),
    /not a supported image/,
  );
  const image = writeAttachmentChunk({
    workspacePath,
    relativePath: "d/big.png",
    offset: 0,
    data: png,
    final: true,
  });
  assert.throws(
    () =>
      readAttachmentImageChunk({
        workspacePath,
        path: image.path,
        offset: 0,
        maxBytes: 10,
      }),
    /too large/,
  );
});
