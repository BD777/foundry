import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  readFileSync,
  rmSync,
  symlinkSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checkoutOrigins,
  writeCheckedOutSkill,
} from "../dist/skills/checkout-workspace-skill.js";

const ref = { skillId: "sk_demo", revision: 2 };
const files = [
  { path: "SKILL.md", data: Buffer.from("draft") },
  { path: "references/manual", data: Buffer.from("instructions") },
];

function folder(t) {
  const dir = mkdtempSync(join(tmpdir(), "foundry-checkout-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("checkout copies the library files and refuses any existing directory", (t) => {
  const root = folder(t);
  writeCheckedOutSkill(root, "sample", files, ref);
  const target = join(root, ".agents", "skills", "sample");
  assert.equal(
    readFileSync(join(target, "references/manual"), "utf8"),
    "instructions",
  );
  assert.throws(
    () =>
      writeCheckedOutSkill(
        root,
        "sample",
        [{ path: "SKILL.md", data: Buffer.from("replacement") }],
        ref,
      ),
    { code: "EEXIST" },
  );
  assert.equal(readFileSync(join(target, "SKILL.md"), "utf8"), "draft");
  mkdirSync(join(target, "..", "empty"));
  assert.throws(() => writeCheckedOutSkill(root, "empty", files, ref), {
    code: "EEXIST",
  });
});

test("checkout rejects unsafe destinations and removes incomplete copies", (t) => {
  const root = folder(t);
  const outside = folder(t);
  assert.throws(() => writeCheckedOutSkill(root, "../outside", files, ref));
  symlinkSync(outside, join(root, ".agents"), "dir");
  assert.throws(() => writeCheckedOutSkill(root, "sample", files, ref));
  assert.deepEqual(readdirSync(outside), []);
  rmSync(join(root, ".agents"));
  assert.throws(() =>
    writeCheckedOutSkill(
      root,
      "sample",
      [...files, { path: "../unexpected", data: Buffer.alloc(0) }],
      ref,
    ),
  );
  assert.equal(existsSync(join(root, ".agents", "skills", "sample")), false);
});

test("checkout origin survives a lost reply and is invalidated by directory replacement", (t) => {
  const root = folder(t);
  const drafts = [{ relativePath: ".agents/skills/sample" }];
  const id = writeCheckedOutSkill(root, "sample", files, ref);
  assert.deepEqual(checkoutOrigins(root, drafts), {
    ".agents/skills/sample": { ...ref, directoryId: id },
  });
  const target = join(root, ".agents/skills/sample");
  renameSync(target, target + "-old");
  mkdirSync(target);
  assert.deepEqual(checkoutOrigins(root, drafts), {});
});
