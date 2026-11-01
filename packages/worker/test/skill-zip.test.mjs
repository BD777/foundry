import assert from "node:assert/strict";
import test from "node:test";
import { deflateRawSync } from "node:zlib";
import { packZip, unpackZip, assertSafeEntryPath } from "../dist/skill-zip.js";

const LIMITS = { maxBytes: 1 << 20, maxFiles: 100 };

test("pack then unpack roundtrips entries in order", () => {
  const entries = [
    { path: "SKILL.md", data: Buffer.from("---\nname: demo\n---\n# Demo\n") },
    { path: "scripts/run.sh", data: Buffer.from("echo hi\n") },
    { path: "references/a.md", data: Buffer.from("ref") },
  ];
  const zip = packZip(entries);
  const result = unpackZip(zip, LIMITS);
  const byPath = new Map(result.map((entry) => [entry.path, entry.data]));
  assert.equal(byPath.size, 3);
  assert.deepEqual(byPath.get("SKILL.md"), entries[0].data);
  assert.deepEqual(byPath.get("scripts/run.sh"), entries[1].data);
  assert.deepEqual(byPath.get("references/a.md"), entries[2].data);
});

test("unpack reads deflate-compressed members", () => {
  const payload = Buffer.from("compressed content ".repeat(50));
  const name = Buffer.from("note.txt");
  const crc = 0x137e8f9a; // Python zlib CRC32 golden value
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(name.length, 26);
  const compressed = deflateRawSync(payload);
  local.writeUInt32LE(compressed.length, 18);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(payload.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0x80000000, 38);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + name.length, 12);
  eocd.writeUInt32LE(local.length + name.length + compressed.length, 16);
  const zip = Buffer.concat([local, name, compressed, central, name, eocd]);
  const result = unpackZip(zip, LIMITS);
  assert.deepEqual(result[0].data, payload);
});

test("unsafe paths are rejected", () => {
  assert.throws(() => assertSafeEntryPath("../escape"), /escapes/);
  assert.throws(() => assertSafeEntryPath("a/../../b"), /escapes/);
  assert.throws(() => assertSafeEntryPath("/abs/path"), /absolute/);
  assert.throws(() => assertSafeEntryPath("a\\b"), /backslash/);
});

test("oversized member trips the bound", () => {
  const entries = [{ path: "big.bin", data: Buffer.alloc(1024) }];
  const zip = packZip(entries);
  assert.throws(
    () => unpackZip(zip, { maxBytes: 512, maxFiles: 100 }),
    /size bound/,
  );
});

test("a member whose CRC does not match is refused", () => {
  const zip = packZip([{ path: "SKILL.md", data: Buffer.from("content\n") }]);
  const wrong = Buffer.from(zip);
  const central = wrong.readUInt32LE(wrong.length - 6);
  wrong.writeUInt32LE(0, central + 16);
  assert.throws(() => unpackZip(wrong, LIMITS), /checksum/);
});

test("ZIP writer matches the standard IEEE CRC32 check vector", () => {
  const zip = packZip([{ path: "SKILL.md", data: Buffer.from("123456789") }]);
  assert.equal(zip.readUInt32LE(14), 0xcbf43926);
});
