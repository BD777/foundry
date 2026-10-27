import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSessionFile,
  readSessionFileChunk,
} from "../dist/session-files.js";
import {
  readWorkspaceFileDownload,
  safeWorkspaceFileRead,
} from "../dist/workspace-files.js";
import {
  FileDownloadError,
  maxFileDownloadBytes,
} from "../dist/file-downloads.js";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "foundry-file-download-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspacePath = join(root, "workspace");
  const home = join(root, "home");
  mkdirSync(workspacePath);
  mkdirSync(home);
  const path = join(workspacePath, "数据.bin");
  const sessionId = "sess_download";
  const ledgerFolder = join(workspacePath, ".foundry", "sessions", sessionId);
  mkdirSync(ledgerFolder, { recursive: true });
  const record = (file = path, origin = "tool") =>
    writeFileSync(
      join(ledgerFolder, "files.json"),
      JSON.stringify({
        version: 1,
        files: [
          {
            path: file,
            origin,
            op: "created",
            inGitRepo: false,
            inputIds: [],
            agent: "main",
            realpath: realpathSync(file),
          },
        ],
      }),
    );
  const input = { workspacePath, home, sessionId, path };
  return { root, path, input, record };
}

function allChunks(read) {
  const parts = [];
  let offset = 0;
  let revision;
  for (;;) {
    const chunk = read({ offset, revision }).downloadChunk;
    assert.equal(chunk.offset, offset);
    assert.ok(chunk.revision);
    if (revision) assert.equal(chunk.revision, revision);
    revision = chunk.revision;
    const data = Buffer.from(chunk.dataBase64, "base64");
    assert.ok(data.length <= 64 * 1024);
    parts.push(data);
    offset += data.length;
    if (offset >= chunk.size) return Buffer.concat(parts);
    assert.ok(data.length > 0);
  }
}

test("workspace and session downloads preserve every byte beyond preview limits", (t) => {
  const f = fixture(t);
  const bytes = Buffer.from("第😀行\r\n".repeat(65000));
  writeFileSync(f.path, bytes);
  f.record();
  // Rename extension for a text preview, without changing the ledger path.
  const text = join(f.input.workspacePath, "large.json");
  writeFileSync(text, bytes);
  f.record(text);
  assert.equal(readSessionFile({ ...f.input, path: text }).truncated, true);
  assert.equal(
    safeWorkspaceFileRead(f.input.workspacePath, {
      workspaceId: "ws",
      path: text,
    }).truncated,
    true,
  );
  assert.deepEqual(
    allChunks((download) =>
      readSessionFileChunk({ ...f.input, path: text, download }),
    ),
    bytes,
  );
  assert.deepEqual(
    allChunks((download) =>
      readWorkspaceFileDownload(f.input.workspacePath, {
        workspaceId: "ws",
        path: text,
        download,
      }),
    ),
    bytes,
  );
  const binary = Buffer.from(Array.from({ length: 180000 }, (_, i) => i % 256));
  writeFileSync(f.path, binary);
  f.record();
  assert.deepEqual(
    allChunks((download) => readSessionFileChunk({ ...f.input, download })),
    binary,
  );
});

test("download keeps session ledger, private-path, symlink and workspace Git policies", (t) => {
  const f = fixture(t);
  writeFileSync(f.path, "inside");
  f.record();
  assert.throws(
    () =>
      readSessionFileChunk({
        ...f.input,
        path: join(f.root, "unrecorded"),
        download: { offset: 0 },
      }),
    /not one this chat/,
  );
  const outside = join(f.root, "outside.txt");
  writeFileSync(outside, "outside");
  unlinkSync(f.path);
  symlinkSync(outside, f.path);
  assert.throws(
    () => readSessionFileChunk({ ...f.input, download: { offset: 0 } }),
    /resolves somewhere else/,
  );
  assert.throws(
    () =>
      readWorkspaceFileDownload(f.input.workspacePath, {
        workspaceId: "ws",
        path: f.path,
        download: { offset: 0 },
      }),
    /outside/,
  );
  f.record(outside, "reference");
  const allowed = readSessionFileChunk({
    ...f.input,
    path: outside,
    download: { offset: 0 },
  });
  assert.equal(allowed.origin, "reference");
  assert.equal(allowed.insideWorkspace, false);
  const secret = join(f.input.home, ".ssh", "id_rsa");
  mkdirSync(join(f.input.home, ".ssh"));
  writeFileSync(secret, "private");
  f.record(secret);
  assert.throws(
    () =>
      readSessionFileChunk({
        ...f.input,
        path: secret,
        download: { offset: 0 },
      }),
    /not shown/,
  );
  const git = join(f.input.workspacePath, ".git");
  mkdirSync(git);
  writeFileSync(join(git, "config"), "private");
  assert.throws(
    () =>
      readWorkspaceFileDownload(f.input.workspacePath, {
        workspaceId: "ws",
        path: ".git/config",
        download: { offset: 0 },
      }),
    /Git internals/,
  );
});

test("changed files, invalid offsets and large files are refused before returning mixed bytes", (t) => {
  const f = fixture(t);
  writeFileSync(f.path, Buffer.alloc(70000, 1));
  f.record();
  const first = readSessionFileChunk({
    ...f.input,
    download: { offset: 0 },
  }).downloadChunk;
  appendFileSync(f.path, "changed");
  assert.throws(
    () =>
      readSessionFileChunk({
        ...f.input,
        download: { offset: 65536, revision: first.revision },
      }),
    (e) => e instanceof FileDownloadError && e.code === "changed",
  );
  for (const offset of [-1, 0.5, Number.NaN, 999999])
    assert.throws(
      () => readSessionFileChunk({ ...f.input, download: { offset } }),
      (e) => e.code === "invalid_offset",
    );
  const fd = openSync(f.path, "w");
  ftruncateSync(fd, maxFileDownloadBytes + 1);
  closeSync(fd);
  assert.throws(
    () => readSessionFileChunk({ ...f.input, download: { offset: 0 } }),
    (e) => e.code === "too_large",
  );
  writeFileSync(f.path, "");
  assert.equal(
    readSessionFileChunk({ ...f.input, download: { offset: 0 } }).downloadChunk
      .size,
    0,
  );
});
