import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createHash } from "node:crypto";

register("./bundler-resolve.mjs", import.meta.url);
const {
  listVerifications,
  readPreviewMaterial,
  askIssueStatus,
  uploadMaterial,
} = await import("../src/features/issue-detail/evidence-api.ts");

test("evidence pagination includes older selected judgments instead of stopping at page twenty", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  const requests = [];
  globalThis.fetch = async (url) => {
    const page = Number(new URL(url).searchParams.get("page"));
    requests.push(page);
    const count = page === 1 ? 100 : 3;
    return Response.json({
      items: Array.from({ length: count }, (_, i) => ({
        id: `v${(page - 1) * 100 + i}`,
      })),
      total: 103,
    });
  };
  const result = await listVerifications("issue");
  assert.deepEqual(requests, [1, 2]);
  assert.equal(result.items.length, 103);
  assert.equal(result.items.at(-1).id, "v102");
});

test("preview verifies sealed bytes and refuses active formats or silent truncation", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  const bytes = Buffer.from("<script>not executable</script>");
  const material = {
    id: "m",
    byteSize: bytes.length,
    mimeType: "text/plain",
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response(bytes);
  };
  const blob = await readPreviewMaterial("issue", material);
  assert.equal(blob.type, "text/plain");
  assert.equal(await blob.text(), bytes.toString());
  await assert.rejects(
    readPreviewMaterial("issue", { ...material, mimeType: "image/svg+xml" }),
    /Preview unavailable/,
  );
  await assert.rejects(
    readPreviewMaterial("issue", { ...material, byteSize: 3 * 1024 * 1024 }),
    /Preview unavailable/,
  );
  assert.equal(requests, 1);
  globalThis.fetch = async () => new Response(bytes.subarray(1));
  await assert.rejects(
    readPreviewMaterial("issue", material),
    /material_corrupt/,
  );
});

test("status conversation uses the normal API without credential setup", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  globalThis.fetch = async (url, options) => {
    assert.match(url, /\/issues\/issue\/conversation\/status$/);
    assert.deepEqual(options.headers, {
      "Content-Type": "application/json",
      "Idempotency-Key": "stable-key",
    });
    assert.deepEqual(JSON.parse(options.body), { message: "status" });
    return Response.json({ id: "issue" });
  };
  assert.deepEqual(await askIssueStatus("issue", "status", "stable-key"), {
    id: "issue",
  });
});

test("reference upload uses the normal API without an extra credential", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  const file = new File(["reference only"], "reference.txt", {
    type: "text/plain",
  });
  globalThis.fetch = async (url, options) => {
    assert.match(url, /\/materials\?name=reference.txt&carrier=document$/);
    assert.deepEqual(options.headers, { "Idempotency-Key": "upload-key" });
    assert.equal(options.body, file);
    return Response.json({ id: "reference-material" });
  };
  assert.deepEqual(
    await uploadMaterial("issue", file, "document", "upload-key"),
    { id: "reference-material" },
  );
});
