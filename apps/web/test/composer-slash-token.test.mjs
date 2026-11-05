import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./bundler-resolve.mjs", import.meta.url);

const { activeSlashToken } =
  await import("../src/components/ui/message-composer.tsx");

const at = (text) => activeSlashToken(text, text.length);

test("a slash opens the menu at the start, after a space or on a new line", () => {
  assert.deepEqual(at("/byte"), { slashStart: 0, query: "byte" });
  assert.deepEqual(at("  /"), { slashStart: 2, query: "" });
  assert.deepEqual(at("123 /byte"), { slashStart: 4, query: "byte" });
  assert.deepEqual(at("first line\n/re"), { slashStart: 11, query: "re" });
  assert.deepEqual(at("use /review then /bytedance-ab"), {
    slashStart: 17,
    query: "bytedance-ab",
  });
});

test("a slash inside a word, a path or after the query ends opens nothing", () => {
  assert.equal(at("123/byte"), undefined);
  assert.equal(at("see src/components"), undefined);
  assert.equal(at("https://example.invalid/x"), undefined);
  assert.equal(at("/review "), undefined);
  assert.equal(at("/review now"), undefined);
});

test("the token is read at the caret, not at the end of the text", () => {
  const text = "ask /rev about it";
  assert.deepEqual(activeSlashToken(text, "ask /rev".length), {
    slashStart: 4,
    query: "rev",
  });
  assert.equal(activeSlashToken(text, text.length), undefined);
});
