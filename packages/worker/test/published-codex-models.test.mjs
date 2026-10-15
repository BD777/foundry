import assert from "node:assert/strict";
import test from "node:test";
import {
  publishedCodexModels,
  withPublishedCodexModels,
} from "../dist/published-codex-models.js";

const html =
  '<code>retired-model</code><div data-model-slug="gpt-6-astra"></div><div data-model-slug="gpt-6.1-sol"></div><div data-model-slug="gpt-6-luna"></div><div data-model-slug="gpt-6.1-sol"></div>';
const native = async () => [
  { id: "gpt-6-astra", label: "Astra" },
  { id: "gpt-5.6-sol" },
];
const offline = async () => {
  throw new Error("offline");
};

test("published cards supplement an older CLI and deduplicate without extracting examples", async () => {
  assert.equal(publishedCodexModels(html).length, 3);
  const result = await withPublishedCodexModels(
    native,
    async (url, options) => {
      assert.equal(url, "https://developers.openai.com/codex/models");
      assert.equal(options.credentials, "omit");
      return new Response(html);
    },
  );
  assert.deepEqual(result, [
    { id: "gpt-6-astra", label: "Astra" },
    { id: "gpt-6.1-sol" },
    { id: "gpt-6-luna" },
    { id: "gpt-5.6-sol" },
  ]);
});

test("offline, changed markup and HTTP errors preserve the native catalog", async () => {
  for (const fetcher of [
    offline,
    async () => new Response("changed markup"),
    async () => new Response(html, { status: 503 }),
  ]) {
    assert.deepEqual(
      await withPublishedCodexModels(native, fetcher),
      await native(),
    );
  }
});

test("published models survive native failure, but both failures are reported", async () => {
  assert.deepEqual(
    await withPublishedCodexModels(offline, async () => new Response(html)),
    publishedCodexModels(html),
  );
  await assert.rejects(
    withPublishedCodexModels(offline, offline),
    /Could not read/,
  );
});
