import { removeSkillSnapshotTree } from "../dist/skills/skill-snapshot-permissions.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  chmodSync,
  statSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  markPrivateInputOwner,
  reapPrivateInputOwners,
  inputOwnerFile,
} from "../dist/platform/process/private-input-owners.js";
import {
  materializeSkillSnapshot,
  collectSkillSnapshotGarbage,
  readVerifiedSkillSnapshot,
} from "../dist/skills/skill-snapshots.js";
import { prepareNativeOperation } from "../dist/harness/native/native-operation.js";
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "input-maintenance-"));
  t.after(() => removeSkillSnapshotTree(root));
  return root;
}
function mark(path, stale = false) {
  markPrivateInputOwner(path, "claude-settings");
  const file = join(path, inputOwnerFile);
  const record = JSON.parse(readFileSync(file, "utf8"));
  record.supervised = true;
  record.createdAt = 0;
  if (stale) record.startTime = "previous-process-with-the-same-pid";
  writeFileSync(file, JSON.stringify(record));
}

test("secret cleanup keeps live and unknown owners and never follows history links", (t) => {
  const root = fixture(t);
  const managed = join(root, "managed");
  mkdirSync(managed);
  const live = join(managed, "live"),
    stale = join(managed, "stale"),
    unknown = join(managed, "legacy"),
    source = join(root, "original-login");
  for (const path of [live, stale, unknown, source]) mkdirSync(path);
  writeFileSync(join(source, "auth.json"), "original credential");
  mark(live);
  mark(stale, true);
  writeFileSync(join(stale, "settings.json"), "temporary secret");
  symlinkSync(source, join(stale, "history"));
  assert.equal(
    reapPrivateInputOwners(managed, "claude-settings", { minAgeMs: 0 }),
    1,
  );
  assert.ok(existsSync(live));
  assert.ok(existsSync(unknown));
  assert.equal(existsSync(stale), false);
  assert.equal(
    readFileSync(join(source, "auth.json"), "utf8"),
    "original credential",
  );
});

test("cache GC waits for idle, retains historical heads and redirects retired repaired paths to identical bytes", async (t) => {
  const root = fixture(t);
  const key = createHash("sha256").update("gc fixture").digest("hex");
  const describe = (dir) => ({
    files: [{ path: "SKILL.md", data: Buffer.from("verified method") }],
    value: { dir },
  });
  const before = await materializeSkillSnapshot(key, describe, root);
  assert.equal(statSync(before.dir).mode & 0o777, 0o500);
  const file = join(before.dir, "SKILL.md");
  assert.equal(statSync(file).mode & 0o777, 0o400);
  assert.equal(statSync(before.manifestFile).mode & 0o777, 0o400);
  if (process.getuid?.() !== 0) {
    assert.throws(() => writeFileSync(file, "ordinary edit"), {
      code: "EACCES",
    });
    assert.throws(() => writeFileSync(join(before.dir, "extra"), ""), {
      code: "EACCES",
    });
  }
  chmodSync(file, 0o600);
  writeFileSync(file, "corrupted");
  chmodSync(file, 0o400);
  const after = await materializeSkillSnapshot(key, describe, root);
  assert.notEqual(before.dir, after.dir);
  assert.equal(
    collectSkillSnapshotGarbage({ idle: false, minAgeMs: 0 }, root),
    0,
  );
  assert.ok(existsSync(before.dir));
  assert.equal(
    collectSkillSnapshotGarbage({ idle: true, minAgeMs: 0 }, root),
    1,
  );
  assert.ok(existsSync(after.dir));
  assert.equal(existsSync(before.dir), false);
  assert.equal(
    readVerifiedSkillSnapshot(
      before.dir,
      before.snapshotDigest,
    )[0].data.toString(),
    "verified method",
  );
  assert.equal(
    collectSkillSnapshotGarbage({ idle: true, minAgeMs: 0 }, root),
    0,
  );
});

test("writable legacy generations are replaced and abandoned sealed staging trees can be collected", async (t) => {
  const root = fixture(t);
  const key = createHash("sha256").update("legacy generation").digest("hex");
  const build = () =>
    materializeSkillSnapshot(
      key,
      (dir) => ({
        files: [
          { path: "skills/demo/SKILL.md", data: Buffer.from("original") },
        ],
        value: { dir },
      }),
      root,
    );
  const old = await build();
  chmodSync(join(old.dir, "skills/demo/SKILL.md"), 0o600);
  const current = await build();
  assert.notEqual(current.dir, old.dir);
  assert.equal(current.snapshotDigest, old.snapshotDigest);
  assert.equal((await build()).dir, current.dir);

  const staging = join(root, ".staging-abandoned");
  mkdirSync(staging);
  const marker = staging + ".owner.json";
  markPrivateInputOwner(staging, "skill-staging", marker);
  const record = JSON.parse(readFileSync(marker, "utf8"));
  writeFileSync(
    marker,
    JSON.stringify({ ...record, startTime: "earlier-process" }),
  );
  const outside = fixture(t);
  chmodSync(outside, 0o500);
  symlinkSync(outside, join(staging, "outside"));
  chmodSync(staging, 0o500);
  assert.equal(
    collectSkillSnapshotGarbage(
      { idle: true, minAgeMs: 0, now: Date.now() + 1000 },
      root,
    ),
    2,
  );
  assert.equal(existsSync(staging), false);
  assert.equal(existsSync(marker), false);
  assert.equal(statSync(outside).mode & 0o777, 0o500);
  assert.ok(existsSync(current.dir));
});

test("metadata preparation owns disposable history/configuration but leaves the real login source intact", (t) => {
  const root = fixture(t),
    source = join(root, "source");
  mkdirSync(source);
  writeFileSync(join(source, "auth.json"), "synthetic credential");
  for (const runtime of ["codex", "claude"]) {
    const operation = prepareNativeOperation(
      { runtime, id: "metadata", connectionType: "local_login" },
      { HOME: root, CODEX_HOME: source, CLAUDE_CONFIG_DIR: source },
      root,
    );
    const key = runtime === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
    const config = operation.env[key];
    assert.notEqual(config, source);
    assert.ok(existsSync(config));
    const metadata = JSON.parse(
      readFileSync(join(config, ".foundry-native-execution.json"), "utf8"),
    );
    assert.notEqual(metadata.sources.dataHome, source);
    assert.ok(existsSync(metadata.sources.dataHome));
    operation.dispose();
    operation.dispose();
    assert.equal(existsSync(config), false);
    assert.equal(existsSync(metadata.sources.dataHome), false);
    assert.equal(
      readFileSync(join(source, "auth.json"), "utf8"),
      "synthetic credential",
    );
  }
});

test("snapshot reopening rejects linked and escaping paths before reading their contents", (t) => {
  const root = fixture(t);
  const snapshot = join(root, "snapshot");
  mkdirSync(snapshot);
  writeFileSync(join(root, "outside"), "outside");
  symlinkSync(join(root, "outside"), join(snapshot, "linked"));
  for (const path of ["linked", "../outside"]) {
    const body =
      JSON.stringify({
        version: 1,
        files: [
          {
            path,
            bytes: 7,
            sha256: createHash("sha256").update("outside").digest("hex"),
          },
        ],
      }) + "\n";
    writeFileSync(join(snapshot, ".foundry-input-snapshot.json"), body);
    assert.throws(
      () =>
        readVerifiedSkillSnapshot(
          snapshot,
          createHash("sha256").update(body).digest("hex"),
        ),
      /Unsafe skill snapshot/,
    );
  }
});

test("collecting a dead Codex configuration retains native-index history addresses without credentials", (t) => {
  const root = fixture(t),
    managed = join(root, "managed"),
    home = join(managed, "dead");
  const source = join(root, "native-source");
  mkdirSync(home, { recursive: true });
  for (const name of ["sessions", "archived_sessions"]) {
    mkdirSync(join(source, name), { recursive: true });
    symlinkSync(join(source, name), join(home, name));
  }
  writeFileSync(join(source, "sessions", "native.jsonl"), "retained history");
  markPrivateInputOwner(home, "native-config");
  const marker = JSON.parse(readFileSync(join(home, inputOwnerFile), "utf8"));
  Object.assign(marker, {
    supervised: true,
    createdAt: 0,
    startTime: "prior-process",
  });
  writeFileSync(join(home, inputOwnerFile), JSON.stringify(marker));
  writeFileSync(
    join(home, ".foundry-native-execution.json"),
    JSON.stringify({
      version: 1,
      runtime: "codex",
      configHome: home,
      sources: { dataHome: source },
    }),
  );
  writeFileSync(join(home, "config.toml"), "private configuration");
  writeFileSync(join(home, "auth.json"), "temporary secret");
  assert.equal(
    reapPrivateInputOwners(managed, "native-config", { minAgeMs: 0 }),
    1,
  );
  assert.equal(
    readFileSync(join(home, "sessions", "native.jsonl"), "utf8"),
    "retained history",
  );
  assert.equal(existsSync(join(home, "config.toml")), false);
  assert.equal(existsSync(join(home, "auth.json")), false);
  assert.equal(
    reapPrivateInputOwners(managed, "native-config", { minAgeMs: 0 }),
    0,
  );
});
