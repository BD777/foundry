import { unpackZip } from "../dist/skill-zip.js";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  scanSkillRoots,
  packageSkillDirectory,
  readSkillTextFile,
} from "../dist/skill-scanner.js";

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "foundry-skill-scan-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeSkill(dirName, frontmatter) {
  const dir = join(root, dirName);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), frontmatter);
  writeFileSync(join(dir, "scripts", "run"), "echo ok\n");
  return dir;
}

test("scan lists valid skills and parses frontmatter", () => {
  makeSkill(
    "demo-skill",
    `---\nname: demo-skill\ndescription: A demo skill\n---\n# Demo\n`,
  );
  mkdirSync(join(root, "no-skill-file"));
  writeFileSync(join(root, "loose.txt"), "ignored");

  const found = scanSkillRoots([root]);
  assert.equal(found.length, 1);
  assert.equal(found[0].dirName, "demo-skill");
  assert.equal(found[0].name, "demo-skill");
  assert.equal(found[0].description, "A demo skill");
  assert.ok(found[0].sizeBytes > 0);
});

test("invalid frontmatter name falls back to the directory name", () => {
  makeSkill("weird dir", `---\nname: "bad name!"\n---\n`);
  const [skill] = scanSkillRoots([root]);
  assert.equal(skill.name, "weird dir");
});

test("missing root is not an error", () => {
  assert.deepEqual(scanSkillRoots([join(root, "does-not-exist")]), []);
});

test("package zips the skill contents from its root", () => {
  makeSkill("pkg", `---\nname: pkg\ndescription: Packaged\n---\n`);
  const pkg = packageSkillDirectory(root, "pkg");
  assert.equal(pkg.name, "pkg");
  assert.equal(pkg.description, "Packaged");
  assert.ok(pkg.fileCount >= 2);
  assert.ok(pkg.contentBase64.length > 0);
});

test("symlinked content is skipped rather than packed", () => {
  const dir = makeSkill(
    "linky",
    `---\nname: linky\ndescription: link test\n---\n`,
  );
  symlinkSync("/etc/hosts", join(dir, "escape-link"));
  const pkg = packageSkillDirectory(root, "linky");
  const decoded = Buffer.from(pkg.contentBase64, "base64");
  assert.ok(!decoded.includes("escape-link"));
});

test("top-level symlinked skills are followed; broken links are skipped", () => {
  // Real skill store lives elsewhere, like ~/.agents/skills.
  const store = join(root, "store", "linked-skill");
  mkdirSync(join(store, "bin"), { recursive: true });
  writeFileSync(join(store, "SKILL.md"), "---\nname: linked-skill\n---\n");
  writeFileSync(join(store, "bin", "run"), "echo hi\n");

  const linkRoot = join(root, "linked-root");
  mkdirSync(linkRoot, { recursive: true });
  symlinkSync(store, join(linkRoot, "linked-skill"), "dir");
  symlinkSync(join(root, "missing"), join(linkRoot, "broken-link"), "dir");

  const found = scanSkillRoots([linkRoot]);
  assert.equal(found.length, 1, "only the valid symlinked skill is listed");
  assert.equal(found[0].dirName, "linked-skill");
  assert.ok(found[0].sizeBytes > 0);

  // Packaging resolves the link and materializes real file bytes.
  const pkg = packageSkillDirectory(linkRoot, "linked-skill");
  assert.equal(pkg.name, "linked-skill");
  assert.ok(pkg.fileCount >= 2);
});

test("large skills are compressed intact and bound to the scan contents", () => {
  const dir = makeSkill("large", "---\nname: large\n---\n");
  const content = Buffer.from("large reference document\n".repeat(600000));
  writeFileSync(join(dir, "references.md"), content);
  // Exceed the old 2000-file boundary as well as the old 10-MiB boundary.
  for (let i = 0; i < 2001; i++)
    writeFileSync(join(dir, "scripts", `file-${i}.txt`), `file ${i}`);
  const [scanned] = scanSkillRoots([root]);
  assert.ok(scanned.sizeBytes > 10 << 20);
  assert.equal(scanned.dependencyAnalysisError, undefined);
  const packed = packageSkillDirectory(root, "large");
  assert.equal(packed.sourceDigest, scanned.sourceDigest);
  assert.ok(packed.fileCount > 2000);
  assert.ok(packed.byteSize < scanned.sizeBytes / 2);
  const entries = unpackZip(Buffer.from(packed.contentBase64, "base64"), {
    maxBytes: 256 << 20,
    maxFiles: 50000,
  });
  assert.equal(entries.length, packed.fileCount);
  assert.deepEqual(
    entries.find((e) => e.path === "references.md").data,
    content,
  );
  const before = statSync(join(dir, "SKILL.md"));
  writeFileSync(join(dir, "SKILL.md"), "---\nname: large\n---\nchanged");
  utimesSync(join(dir, "SKILL.md"), before.atime, before.mtime);
  assert.notEqual(
    packageSkillDirectory(root, "large").sourceDigest,
    scanned.sourceDigest,
    "mtime preservation must not bypass content validation",
  );
});

test("scans cache file digests; inline reads are bounded and cannot traverse links", () => {
  const dir = makeSkill("indexed", "---\nname: indexed\n---\nbody");
  const [skill] = scanSkillRoots([root]);
  const md = skill.manifest.find((f) => f.path === "SKILL.md");
  assert.equal(
    readSkillTextFile(root, "indexed", "SKILL.md").digest,
    md.digest,
  );
  symlinkSync("/etc/hosts", join(dir, "external.md"));
  assert.throws(
    () => readSkillTextFile(root, "indexed", "external.md"),
    /symlink/,
  );
  assert.throws(
    () => readSkillTextFile(root, "indexed", "../escape"),
    /escapes/,
  );
  writeFileSync(join(dir, "large.md"), Buffer.alloc(600 * 1024, 65));
  assert.throws(
    () => readSkillTextFile(root, "indexed", "large.md"),
    /too large/,
  );
});
