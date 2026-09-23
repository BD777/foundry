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

test("writer emits standard CRC32; historical CRC is opt-in after archive verification", () => {
  const data = Buffer.from("legacy content for CRC interoperability\n");
  const zip = packZip([{ path: "SKILL.md", data }]);
  assert.equal(zip.readUInt32LE(14), 0xe9eb407c);
  const legacy = Buffer.from(zip);
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let old = 0xffffffff;
  for (const b of data) old = (table[(old ^ b) >>> 0] ?? 0) ^ (old >>> 8);
  old = (old ^ 0xffffffff) >>> 0;
  legacy.writeUInt32LE(old, 14);
  const central = legacy.readUInt32LE(legacy.length - 6);
  legacy.writeUInt32LE(old, central + 16);
  assert.throws(() => unpackZip(legacy, LIMITS), /checksum/);
  assert.deepEqual(
    unpackZip(legacy, { ...LIMITS, allowLegacyCrc: true })[0].data,
    data,
  );
  const wrong = Buffer.from(zip);
  wrong.writeUInt32LE(0, central + 16);
  assert.throws(
    () => unpackZip(wrong, { ...LIMITS, allowLegacyCrc: true }),
    /checksum/,
  );
});

test("ZIP writer matches the standard IEEE CRC32 check vector", () => {
  const zip = packZip([{ path: "SKILL.md", data: Buffer.from("123456789") }]);
  assert.equal(zip.readUInt32LE(14), 0xcbf43926);
});
