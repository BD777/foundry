import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import {
  prepareSkillContent,
  skillContentDigest,
} from "../dist/skill-content-cache.js";
import { materializeSessionSkills } from "../dist/skill-materializer.js";
import { foundryStatePath } from "../dist/state-root.js";
import { packZip } from "../dist/skill-zip.js";

function fixture() {
  const name = `cache-${randomUUID()}`;
  const files = [
    {
      path: "SKILL.md",
      data: Buffer.from(
        `---\nname: ${name}\ndescription: Test cache integrity\n---\nOriginal method`,
      ),
    },
    { path: "scripts/tool.js", data: Buffer.from("console.log('original');") },
    { path: "references/🚀.txt", data: Buffer.from("Unicode") },
  ];
  const zip = packZip(files);
  const ref = {
    skillId: name,
    name,
    revision: 1,
    checksum: createHash("sha256").update(zip).digest("hex"),
    byteSize: zip.length,
    sourceDigest: skillContentDigest(files),
  };
  return { files, zip, ref };
}

function installArchive({ zip, ref }) {
  mkdirSync(foundryStatePath("skill-archives"), { recursive: true });
  writeFileSync(foundryStatePath("skill-archives", `${ref.checksum}.zip`), zip);
}

test("content digest uses the server's UTF-16 ordering and binary framing", () => {
  assert.equal(
    skillContentDigest([
      { path: "references/\ue000.txt", data: Buffer.from("bmp") },
      { path: "SKILL.md", data: Buffer.from("method") },
      { path: "references/🚀.txt", data: Buffer.from("supplementary") },
    ]),
    "ca23927a531692a2dd71b09ed2195a4415574efd6b1d6a5a1533167664956b35",
  );
});

test("expanded cache survives a process restart without ZIP or network; all bytes are authenticated", async () => {
  const f = fixture();
  installArchive(f);
  assert.equal((await prepareSkillContent("", f.ref)).source, "archive-cache");
  const archive = foundryStatePath("skill-archives", `${f.ref.checksum}.zip`);
  rmSync(archive);
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { prepareSkillContent } from ${JSON.stringify(new URL("../dist/skill-content-cache.js", import.meta.url).href)};
    const result = await prepareSkillContent("http://127.0.0.1:1", JSON.parse(process.argv[1]));
    console.log(result.source);
  `,
      JSON.stringify(f.ref),
    ],
    { encoding: "utf8" },
  );
  assert.equal(output.trim(), "expanded-cache");
  const path = foundryStatePath("skill-content", `${f.ref.checksum}.bin`);
  const bytes = readFileSync(path);
  bytes[bytes.length - 1] ^= 1;
  writeFileSync(path, bytes);
  installArchive(f);
  const repaired = await prepareSkillContent("", f.ref);
  assert.equal(repaired.source, "archive-cache");
  assert.deepEqual(repaired.files, f.files);
  // Substituting a different valid package cannot authenticate under this ref.
  const other = fixture();
  installArchive(other);
  await prepareSkillContent("", other.ref);
  writeFileSync(
    path,
    readFileSync(
      foundryStatePath("skill-content", `${other.ref.checksum}.bin`),
    ),
  );
  assert.equal((await prepareSkillContent("", f.ref)).source, "archive-cache");
});

test("a cache symlink and malicious header are ignored; wrong trusted digest fails closed", async () => {
  const f = fixture();
  installArchive(f);
  await prepareSkillContent("", f.ref);
  const path = foundryStatePath("skill-content", `${f.ref.checksum}.bin`);
  const saved = readFileSync(path);
  rmSync(path);
  symlinkSync("/dev/null", path);
  assert.equal((await prepareSkillContent("", f.ref)).source, "archive-cache");
  const header = Buffer.from(
    JSON.stringify([{ path: "../../outside", bytes: 0 }]),
  );
  const size = Buffer.alloc(4);
  size.writeUInt32LE(header.length);
  writeFileSync(path, Buffer.concat([size, header]));
  assert.equal((await prepareSkillContent("", f.ref)).source, "archive-cache");
  writeFileSync(path, saved);
  await assert.rejects(
    prepareSkillContent("", { ...f.ref, sourceDigest: "0".repeat(64) }),
    /digest mismatch/,
  );
});

test("prepared content still repairs a tampered runtime generation without replacing the old path", async () => {
  const f = fixture();
  installArchive(f);
  const first = await materializeSessionSkills([f.ref], "", "/unused");
  const path = `${first.skills[0].dir}/scripts/tool.js`;
  writeFileSync(path, "tampered");
  let stats;
  const next = await materializeSessionSkills([f.ref], "", "/unused", {
    onComplete: (s) => {
      stats = s;
    },
  });
  assert.notEqual(next.pluginDir, first.pluginDir);
  assert.equal(readFileSync(path, "utf8"), "tampered");
  assert.equal(
    readFileSync(`${next.skills[0].dir}/scripts/tool.js`, "utf8"),
    "console.log('original');",
  );
  assert.equal(stats.expandedCache, 1);
  assert.equal(stats.unpacked, undefined);
  assert.equal(stats.unpackMs, 0);
});

test("overlapping consumers share a download; canceling one does not abort another", async (t) => {
  const f = fixture();
  let downloads = 0,
    release;
  const server = createServer((_request, response) => {
    downloads++;
    release = () => response.end(f.zip);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const abort = new AbortController();
  const first = prepareSkillContent(url, f.ref, { signal: abort.signal });
  const rejected = assert.rejects(first, /canceled consumer/);
  const second = prepareSkillContent(url, f.ref);
  while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
  abort.abort(new Error("canceled consumer"));
  release();
  await rejected;
  assert.equal((await second).source, "download");
  assert.equal(downloads, 1);
});

test("canceling the last consumer permits a fresh retry", async (t) => {
  const f = fixture();
  let downloads = 0;
  const server = createServer((_request, response) => {
    if (++downloads > 1) response.end(f.zip);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const abort = new AbortController();
  const first = prepareSkillContent(url, f.ref, { signal: abort.signal });
  const rejected = assert.rejects(first, /last consumer/);
  while (!downloads) await new Promise((resolve) => setTimeout(resolve, 5));
  abort.abort(new Error("last consumer"));
  await rejected;
  assert.equal((await prepareSkillContent(url, f.ref)).source, "download");
  assert.equal(downloads, 2);
});
