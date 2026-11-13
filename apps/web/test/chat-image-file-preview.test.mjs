import assert from "node:assert/strict";
import test from "node:test";
import {
  decideInlineImage,
  imageMimeEssence,
  inlineImagePreviewMaxBytes,
  isInlineImageCandidate,
} from "../src/features/chat/detail/chat-image-preview-model.ts";

test("the Workspace panel recognizes every supported image extension", () => {
  for (const name of [
    "photo.png",
    "photo.jpg",
    "photo.jpeg",
    "animation.gif",
    "photo.webp",
    "photo.avif",
    "photo.bmp",
    "icon.ico",
    "diagram.svg",
    "PHOTO.PNG",
  ]) {
    assert.equal(isInlineImageCandidate(name), true, name);
  }
  assert.equal(isInlineImageCandidate("notes.txt"), false);
  assert.equal(isInlineImageCandidate("archive.svg.bin"), false);
});

test("the server MIME must agree with the extension", () => {
  assert.deepEqual(decideInlineImage("photo.png", 512, "image/png"), {
    kind: "preview",
  });
  assert.deepEqual(
    decideInlineImage("photo.jpg", 512, "image/jpeg; charset=binary"),
    { kind: "preview" },
  );
  assert.deepEqual(decideInlineImage("diagram.svg", 512, "image/svg+xml"), {
    kind: "preview",
  });
  assert.deepEqual(
    decideInlineImage("icon.ico", 512, "image/vnd.microsoft.icon"),
    { kind: "preview" },
  );
  assert.deepEqual(decideInlineImage("photo.png", 512, "image/jpeg"), {
    kind: "not-image",
  });
  assert.deepEqual(
    decideInlineImage("photo.png", 512, "application/octet-stream"),
    { kind: "not-image" },
  );
});

test("images over 20 MiB keep the download notice", () => {
  assert.deepEqual(
    decideInlineImage("large.png", inlineImagePreviewMaxBytes, "image/png"),
    { kind: "preview" },
  );
  assert.deepEqual(
    decideInlineImage("large.png", inlineImagePreviewMaxBytes + 1, "image/png"),
    { kind: "too-large", size: inlineImagePreviewMaxBytes + 1 },
  );
});

test("MIME parsing strips parameters without accepting a lookalike type", () => {
  assert.equal(imageMimeEssence(" Image/PNG; charset=utf-8"), "image/png");
  assert.equal(imageMimeEssence("text/html,image/png"), "text/html,image/png");
});
