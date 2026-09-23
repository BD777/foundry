import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  hardenPrivateFile,
  writePrivateJSONAtomic,
  writePublicTextIfMissing,
} from "../dist/storage.js";

function mode(path) {
  return statSync(path).mode & 0o777;
}

test("private JSON writes are atomic and owner-only", () => {
  const root = mkdtempSync(join(tmpdir(), "foundry-storage-"));
  try {
    const path = join(root, "state", "daemon-config.json");
    writePrivateJSONAtomic(path, { deviceCredential: "secret" });
    writePrivateJSONAtomic(path, { deviceCredential: "updated" });

    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
      deviceCredential: "updated",
    });
    assert.equal(mode(join(root, "state")), 0o700);
    assert.equal(mode(path), 0o600);
    assert.deepEqual(
      readdirSync(join(root, "state")).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("existing state permissions are hardened without rewriting contents", () => {
  const root = mkdtempSync(join(tmpdir(), "foundry-storage-"));
  try {
    const directory = join(root, "state");
    const path = join(directory, "device.json");
    mkdirSync(directory, { mode: 0o755 });
    writeFileSync(path, '{"id":"device"}\n', { mode: 0o644 });
    chmodSync(directory, 0o755);
    chmodSync(path, 0o644);

    hardenPrivateFile(path);

    assert.equal(readFileSync(path, "utf8"), '{"id":"device"}\n');
    assert.equal(mode(directory), 0o700);
    assert.equal(mode(path), 0o600);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("write-if-missing preserves existing public templates", () => {
  const root = mkdtempSync(join(tmpdir(), "foundry-storage-"));
  try {
    const path = join(root, ".foundry", "providers.yaml");
    writePublicTextIfMissing(path, "first\n", 0o700);
    writePublicTextIfMissing(path, "second\n", 0o700);

    assert.equal(readFileSync(path, "utf8"), "first\n");
    assert.equal(mode(join(root, ".foundry")), 0o700);
    assert.equal(mode(path), 0o644);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
