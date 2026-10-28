import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deniedDevicePath,
  readDeviceFile,
  sensitiveDeviceFile,
} from "../dist/device-files.js";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "device-files-"));
  mkdirSync(join(home, ".local/share/app"), { recursive: true });
  mkdirSync(join(home, ".ssh"));
  mkdirSync(join(home, "notes"));
  writeFileSync(join(home, "notes/plan.md"), "# Plan\n");
  writeFileSync(join(home, ".local/share/app/app.key"), "sk-live-123\n");
  writeFileSync(join(home, ".ssh/id_ed25519"), "private\n");
  writeFileSync(join(home, "notes/blob.bin"), Buffer.from([1, 0, 2, 3]));
  writeFileSync(
    join(home, "notes/server.txt"),
    "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n",
  );
  // A link that looks harmless but leads into a credential store.
  symlinkSync(join(home, ".ssh/id_ed25519"), join(home, "notes/innocent.txt"));
  return home;
}

test("a plain file outside the workspaces reads, with its start", () => {
  const home = fixture();
  try {
    const read = readDeviceFile(
      { path: "~/notes/plan.md", mode: "read" },
      home,
    );
    assert.equal(read.kind, "file");
    assert.equal(read.content, "# Plan\n");
    assert.equal(read.sensitive, false);
    assert.equal(read.binary, false);
    assert.equal(read.bytes, 7);
    const stat = readDeviceFile(
      { path: join(home, "notes/plan.md"), mode: "stat" },
      home,
    );
    assert.equal(stat.kind, "file");
    assert.equal(stat.content, undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a secret is masked until revealed and never downloaded", () => {
  const home = fixture();
  try {
    const path = "~/.local/share/app/app.key";
    const read = readDeviceFile({ path, mode: "read" }, home);
    assert.equal(read.kind, "file");
    assert.equal(read.sensitive, true);
    assert.equal(read.content, undefined);
    const revealed = readDeviceFile({ path, mode: "reveal" }, home);
    assert.equal(revealed.content, "sk-live-123\n");
    const download = readDeviceFile(
      { path, mode: "read", download: { offset: 0 } },
      home,
    );
    assert.equal(download.code, "sensitive");
    assert.equal(download.downloadChunk, undefined);
    // Shaped like a private key, whatever its name.
    const key = readDeviceFile(
      { path: "~/notes/server.txt", mode: "read" },
      home,
    );
    assert.equal(key.sensitive, true);
    assert.equal(key.content, undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("credential stores are denied by name and through links", () => {
  const home = fixture();
  try {
    assert.equal(
      readDeviceFile({ path: "~/.ssh/id_ed25519", mode: "reveal" }, home).kind,
      "denied",
    );
    const linked = readDeviceFile(
      { path: "~/notes/innocent.txt", mode: "reveal" },
      home,
    );
    assert.equal(linked.kind, "denied");
    assert.equal(linked.content, undefined);
    for (const path of [
      ".aws/credentials",
      ".gnupg/private-keys-v1.d/x.key",
      ".foundry/server/foundry-secret.key",
      ".codex/auth.json",
      ".claude/.credentials.json",
      ".config/google-chrome/Default/Cookies",
      ".mozilla/firefox/x.default/logins.json",
      "Library/Keychains/login.keychain-db",
      "Library/Application Support/Google/Chrome/Default/Login Data",
      "AppData/Roaming/Microsoft/Credentials/x",
      "repo/.git/config",
    ])
      assert.equal(deniedDevicePath(join(home, path), home), true, path);
    for (const path of ["/etc/shadow", "/proc/self/environ", "/dev/zero"])
      assert.equal(deniedDevicePath(path, home), true, path);
    assert.equal(deniedDevicePath(join(home, "notes/plan.md"), home), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("only regular files: folders, missing and relative paths are refused", () => {
  const home = fixture();
  try {
    assert.equal(
      readDeviceFile({ path: "~/notes", mode: "read" }, home).kind,
      "not_file",
    );
    assert.equal(
      readDeviceFile({ path: "~/notes/gone.md", mode: "read" }, home).kind,
      "missing",
    );
    assert.equal(
      readDeviceFile({ path: "notes/plan.md", mode: "read" }, home).kind,
      "missing",
    );
    const binary = readDeviceFile(
      { path: "~/notes/blob.bin", mode: "read" },
      home,
    );
    assert.equal(binary.binary, true);
    assert.equal(binary.content, undefined);
    const chunk = readDeviceFile(
      { path: "~/notes/blob.bin", mode: "read", download: { offset: 0 } },
      home,
    );
    assert.equal(chunk.downloadChunk?.size, 4);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("secret-looking names", () => {
  for (const name of [
    "a.key",
    "cert.pem",
    "x.p12",
    ".env",
    ".env.local",
    "id_rsa",
    "github_token",
    "db-password.txt",
    "client_secret.json",
    "aws-credentials",
    "openai-api-key.txt",
  ])
    assert.equal(sensitiveDeviceFile(`/x/${name}`), true, name);
  for (const name of ["plan.md", "server.crt", "notes.txt", "keyboard.md"])
    assert.equal(sensitiveDeviceFile(`/x/${name}`), false, name);
});
