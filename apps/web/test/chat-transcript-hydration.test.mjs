import assert from "node:assert/strict";
import test from "node:test";
import { hydrateSessionThreadWithRetry } from "../src/features/chat/chat-transcript-hydration.ts";

test("retries a transient transcript failure without a React dependency change", async () => {
  const controller = new AbortController();
  let attempts = 0;
  let loaded;
  await hydrateSessionThreadWithRetry({
    load: async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("temporary failure");
      }
      return [{ id: "session-1" }];
    },
    onLoaded: (sessions) => {
      loaded = sessions;
    },
    retryDelaysMs: [0],
    signal: controller.signal,
  });

  assert.equal(attempts, 3);
  assert.deepEqual(loaded, [{ id: "session-1" }]);
});

test("stops transcript retries when the selection is aborted", async () => {
  const controller = new AbortController();
  let attempts = 0;
  await hydrateSessionThreadWithRetry({
    load: async () => {
      attempts += 1;
      controller.abort();
      throw new Error("selection changed");
    },
    onLoaded: () => assert.fail("aborted hydration must not publish"),
    retryDelaysMs: [0],
    signal: controller.signal,
  });
  assert.equal(attempts, 1);
});
