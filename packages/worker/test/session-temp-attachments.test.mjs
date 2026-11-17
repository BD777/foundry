import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessionTempFileChunk } from "../dist/workspace/workspace-attachments.js";

const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "fdy-temp-read-"));
  const own = join(root, "own");
  const other = join(root, "other");
  mkdirSync(own);
  mkdirSync(other);
  writeFileSync(join(own, "pie.png"), png);
  writeFileSync(join(other, "pie.png"), png);
  return {
    root,
    own,
    other,
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("a session reads a file in its own temp folder", () => {
  const f = fixture();
  try {
    const chunk = readSessionTempFileChunk({
      tempFolder: f.own,
      otherTempFolders: [f.other],
      path: join(f.own, "pie.png"),
      offset: 0,
      maxBytes: 1 << 20,
    });
    assert.equal(chunk.size, png.length);
    assert.equal(chunk.mimeType, "image/png");
  } finally {
    f.done();
  }
});

test("another session's temp folder is refused by name", () => {
  const f = fixture();
  try {
    assert.throws(
      () =>
        readSessionTempFileChunk({
          tempFolder: f.own,
          otherTempFolders: [f.other],
          path: join(f.other, "pie.png"),
          offset: 0,
          maxBytes: 1 << 20,
        }),
      (error) => error.code === "other_session_temp",
    );
  } finally {
    f.done();
  }
});

test("a path outside both temp folders is refused, and a session without one says so", () => {
  const f = fixture();
  writeFileSync(join(f.root, "pie.png"), png);
  try {
    assert.throws(
      () =>
        readSessionTempFileChunk({
          tempFolder: f.own,
          otherTempFolders: [f.other],
          path: join(f.root, "pie.png"),
          offset: 0,
          maxBytes: 1 << 20,
        }),
      (error) => error.code === "outside_temp",
    );
    assert.throws(
      () =>
        readSessionTempFileChunk({
          tempFolder: undefined,
          otherTempFolders: [f.other],
          path: join(f.own, "pie.png"),
          offset: 0,
          maxBytes: 1 << 20,
        }),
      (error) => error.code === "no_temp_folder",
    );
  } finally {
    f.done();
  }
});
