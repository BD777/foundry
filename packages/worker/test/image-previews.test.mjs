import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { spawnSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import {
  readAttachmentPreviewChunk,
  imagePreviewBudget,
} from "../dist/image-previews.js";
import { writeAttachmentChunk } from "../dist/workspace-attachments.js";

function png(width, height) {
  const crc = (buffer) => {
    let n = 0xffffffff;
    for (const b of buffer) {
      n ^= b;
      for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
    }
    return (n ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const name = Buffer.from(type),
      out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length);
    name.copy(out, 4);
    data.copy(out, 8);
    out.writeUInt32BE(crc(Buffer.concat([name, data])), data.length + 8);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width);
  head.writeUInt32BE(height, 4);
  head[8] = 8;
  head[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  let random = 7;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width * 3; x++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      pixels[y * (width * 3 + 1) + x + 1] = random >>> 24;
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", head),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
test("derivatives stay within byte budgets, never upscale or modify originals", async (t) => {
  if (
    spawnSync("ffmpeg", ["-version"]).status !== 0 ||
    spawnSync("ffprobe", ["-version"]).status !== 0
  )
    return t.skip("installed renderer unavailable");
  const root = mkdtempSync(join(tmpdir(), "fdy-image-previews-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = png(320, 240);
  const { path } = writeAttachmentChunk({
    workspacePath: root,
    relativePath: "source.png",
    offset: 0,
    data,
    final: true,
  });
  const input = {
    workspacePath: root,
    path,
    offset: 0,
    maxBytes: 20 * 1024 * 1024,
  };
  const preview = await readAttachmentPreviewChunk(input, "preview");
  assert.ok(preview.size <= imagePreviewBudget);
  assert.equal(preview.data.length, preview.size);
  assert.deepEqual(readFileSync(path), data);
  const probe = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      "pipe:0",
    ],
    { input: preview.data, encoding: "utf8" },
  );
  const dimensions = JSON.parse(probe.stdout).streams[0];
  assert.ok(dimensions.width <= 320 && dimensions.height <= 240);
  const tiny = await readAttachmentPreviewChunk(input, "placeholder");
  assert.ok(tiny.size <= 2048);
  assert.equal(tiny.revision, preview.revision);
  assert.equal(tiny.realPath, preview.realPath);
  const again = await readAttachmentPreviewChunk(input, "preview");
  assert.deepEqual(again.data, preview.data);
  await assert.rejects(
    readAttachmentPreviewChunk(
      { ...input, path: join(root, "../outside.png") },
      "preview",
    ),
  );
  const small = png(1, 1);
  const saved = writeAttachmentChunk({
    workspacePath: root,
    relativePath: "small.png",
    offset: 0,
    data: small,
    final: true,
  });
  const unchanged = await readAttachmentPreviewChunk(
    { ...input, path: saved.path },
    "preview",
  );
  assert.deepEqual(unchanged.data, small);
});

test("megabyte noise previews meet the budget without falling back to originals", async (t) => {
  if (spawnSync("ffmpeg", ["-version"]).status !== 0)
    return t.skip("installed renderer unavailable");
  const root = mkdtempSync(join(tmpdir(), "fdy-preview-noise-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = png(640, 480);
  assert.ok(data.length > 900000);
  const { path } = writeAttachmentChunk({
    workspacePath: root,
    relativePath: "large.png",
    offset: 0,
    data,
    final: true,
  });
  const r = await readAttachmentPreviewChunk(
    { workspacePath: root, path, offset: 0, maxBytes: 25 * 1024 * 1024 },
    "preview",
  );
  assert.ok(r.size <= imagePreviewBudget);
  assert.equal(r.data.length, r.size);
  assert.notEqual(r.mimeType, "image/png");
  assert.deepEqual(readFileSync(path), data);
});

test("a renderer timeout falls back once and is negatively cached", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX renderer fixture");
  const root = mkdtempSync(join(tmpdir(), "fdy-preview-timeout-"));
  const savedPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = savedPath;
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, "ffmpeg"), "#!/bin/sh\nexec /bin/sleep 3\n", {
    mode: 0o700,
  });
  const data = png(320, 240),
    { path } = writeAttachmentChunk({
      workspacePath: root,
      relativePath: "timeout.png",
      offset: 0,
      data,
      final: true,
    });
  process.env.PATH = root + delimiter + savedPath;
  const input = {
    workspacePath: root,
    path,
    offset: 0,
    maxBytes: 25 * 1024 * 1024,
  };
  const fallback = await readAttachmentPreviewChunk(input, "preview");
  assert.equal(fallback.size, data.length);
  assert.equal(fallback.mimeType, "image/png");
  // A second attempt must not execute a now-different renderer.
  writeFileSync(
    join(root, "ffmpeg"),
    "#!/bin/sh\necho retried > " + join(root, "retried") + "\n",
    { mode: 0o700 },
  );
  const repeat = await readAttachmentPreviewChunk(input, "preview");
  assert.equal(repeat.size, data.length);
  assert.equal(existsSync(join(root, "retried")), false);
});

test("missing ffmpeg and failed encoders skip placeholders and cache original fallback", async (t) => {
  if (process.platform === "darwin" || process.platform === "win32")
    return t.skip("Linux absent-renderer fixture");
  const root = mkdtempSync(join(tmpdir(), "fdy-preview-missing-")),
    oldPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  });
  const data = png(320, 240),
    { path } = writeAttachmentChunk({
      workspacePath: root,
      relativePath: "missing.png",
      offset: 0,
      data,
      final: true,
    }),
    input = {
      workspacePath: root,
      path,
      offset: 0,
      maxBytes: 25 * 1024 * 1024,
    };
  process.env.PATH = root;
  const first = await readAttachmentPreviewChunk(input, "preview");
  assert.equal(first.size, data.length);
  writeFileSync(
    join(root, "ffmpeg"),
    "#!/bin/sh\necho retried > " + join(root, "retried") + "\n",
    { mode: 0o700 },
  );
  await assert.rejects(
    readAttachmentPreviewChunk(input, "placeholder"),
    /tiny image preview unavailable/,
  );
  const repeat = await readAttachmentPreviewChunk(input, "preview");
  assert.equal(repeat.size, data.length);
  assert.equal(existsSync(join(root, "retried")), false);
});

test("failed encoders are not launched again for either derivative", async (t) => {
  if (process.platform === "win32" || process.platform === "darwin")
    return t.skip("Linux failing-renderer fixture");
  const root = mkdtempSync(join(tmpdir(), "fdy-preview-failed-")),
    oldPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  });
  const command = join(root, "ffmpeg");
  writeFileSync(command, '#!/bin/sh\nprintf x >> "$0.calls"\nexit 1\n', {
    mode: 0o700,
  });
  const data = png(320, 240),
    { path } = writeAttachmentChunk({
      workspacePath: root,
      relativePath: "failed.png",
      offset: 0,
      data,
      final: true,
    });
  process.env.PATH = root;
  const input = {
    workspacePath: root,
    path,
    offset: 0,
    maxBytes: 25 * 1024 * 1024,
  };
  assert.equal(
    (await readAttachmentPreviewChunk(input, "preview")).size,
    data.length,
  );
  const first = readFileSync(command + ".calls", "utf8").length;
  assert.equal(
    (await readAttachmentPreviewChunk(input, "preview")).size,
    data.length,
  );
  assert.equal(readFileSync(command + ".calls", "utf8").length, first);
  await assert.rejects(
    readAttachmentPreviewChunk(input, "placeholder"),
    /tiny image preview unavailable/,
  );
  const afterPlaceholder = readFileSync(command + ".calls", "utf8").length;
  await assert.rejects(
    readAttachmentPreviewChunk(input, "placeholder"),
    /tiny image preview unavailable/,
  );
  assert.equal(
    readFileSync(command + ".calls", "utf8").length,
    afterPlaceholder,
  );
});
