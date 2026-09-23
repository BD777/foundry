import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./bundler-resolve.mjs", import.meta.url);
const { loadFoundryWorkspace, prefetchFoundryWorkspace } =
  await import("../src/api.ts");

test("workspace intent reuses the pending request and consumes the snapshot once", async (t) => {
  let finish;
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    if (requests === 1) await new Promise((resolve) => (finish = resolve));
    return Response.json({ workspace: { id: "intent" } });
  });
  prefetchFoundryWorkspace("intent");
  prefetchFoundryWorkspace("intent");
  const loading = loadFoundryWorkspace("intent");
  assert.equal(requests, 1);
  finish();
  assert.equal((await loading).data.workspace.id, "intent");
  await loadFoundryWorkspace("intent");
  assert.equal(requests, 2, "later switches fetch fresh data");
});

test("failed speculative loads retry on selection instead of failing the switch", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    if (++requests === 1) throw new Error("temporarily offline");
    return Response.json({ workspace: { id: "retry" } });
  });
  prefetchFoundryWorkspace("retry");
  assert.equal(
    (await loadFoundryWorkspace("retry")).data.workspace.id,
    "retry",
  );
  assert.equal(requests, 2);
});

test("expired preloads are discarded and canceled selections never apply them", async (t) => {
  let now = 0;
  let requests = 0;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return Response.json({ workspace: { id: "expiry" } });
  });
  prefetchFoundryWorkspace("expiry");
  now = 5_001;
  await loadFoundryWorkspace("expiry");
  assert.equal(requests, 2);
  prefetchFoundryWorkspace("cancel");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    loadFoundryWorkspace("cancel", { signal: controller.signal }),
    { name: "AbortError" },
  );
});
