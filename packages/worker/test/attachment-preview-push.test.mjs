import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  symlinkSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { writeAttachmentChunk } from "../dist/workspace-attachments.js";
import {
  configureAttachmentPreviewPush,
  queueEventImagePreviews,
  noteInteractiveImageRead,
  enqueueAttachmentPreview,
} from "../dist/daemon/attachment-previews.js";
import { WorkspaceRoster } from "../dist/daemon/workspace-roster.js";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6hgAAAAAASUVORK5CYII=",
  "base64",
);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
test("only registered attachment derivatives are pushed once; interactive reads cancel uploads", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "fdy-preview-push-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = writeAttachmentChunk({
    workspacePath: root,
    relativePath: "preview.png",
    offset: 0,
    data: png,
    final: true,
  }).path;
  const registeredPath = join(root, "registered-link");
  symlinkSync(root, registeredPath, "dir");
  const received = [];
  let hold = false,
    closed = false;
  const server = createServer(async (req, res) => {
    const pieces = [];
    for await (const piece of req) pieces.push(piece);
    received.push(JSON.parse(gunzipSync(Buffer.concat(pieces)).toString()));
    if (hold) {
      res.on("close", () => (closed = true));
      return;
    }
    res.writeHead(204);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    configureAttachmentPreviewPush(url, false);
    server.closeAllConnections();
    server.close();
  });
  configureAttachmentPreviewPush(url, true, (folder) =>
    folder === root ? { id: "ws_preview", path: registeredPath } : undefined,
  );
  const envelope = {
    type: "session_event",
    payload: { event: { detail: `<image path="${path}">` } },
  };
  queueEventImagePreviews(url, envelope);
  queueEventImagePreviews(url, envelope);
  for (let n = 0; n < 100 && received.length < 2; n++) await wait(50);
  assert.equal(received.length, 2);
  assert.deepEqual(
    received.map((x) => x.variant),
    ["placeholder", "preview"],
  );
  assert.ok(
    received.every(
      (x) =>
        x.workspaceId === "ws_preview" &&
        x.path.startsWith(join(registeredPath, ".foundry", "attachments")) &&
        Buffer.from(x.dataBase64, "base64").equals(png),
    ),
  );
  enqueueAttachmentPreview(
    url,
    "/unregistered/.foundry/attachments/private.png",
  );
  await wait(1600);
  assert.equal(received.length, 2);
  const another = writeAttachmentChunk({
    workspacePath: root,
    relativePath: "cancel.png",
    offset: 0,
    data: png,
    final: true,
  }).path;
  hold = true;
  enqueueAttachmentPreview(url, another);
  for (let n = 0; n < 100 && received.length < 3; n++) await wait(50);
  assert.equal(received.length, 3);
  noteInteractiveImageRead();
  for (let n = 0; n < 30 && !closed; n++) await wait(20);
  assert.equal(closed, true);
  configureAttachmentPreviewPush(url, false);
});

test("preview workspace lookup accepts registered symlinks without rewriting workspace identity", (t) => {
  const root = mkdtempSync(join(tmpdir(), "fdy-preview-roster-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const real = join(root, "real"),
    alias = join(root, "alias");
  mkdirSync(real);
  const identity = join(real, "workspace.json");
  writeFileSync(identity, "unchanged");
  symlinkSync(real, alias, "dir");
  const roster = new WorkspaceRoster({}, "", {});
  roster.trackMissing("ws_known", alias);
  assert.equal(roster.workspaceIdForFolder(real), "ws_known");
  assert.equal(roster.workspaceIdForFolder(alias), "ws_known");
  assert.equal(roster.workspaceIdForFolder(join(root, "unknown")), undefined);
  assert.equal(readFileSync(identity, "utf8"), "unchanged");
});
