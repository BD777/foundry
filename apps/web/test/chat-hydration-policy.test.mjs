import assert from "node:assert/strict";
import test from "node:test";
import { chatDetailHydrationId } from "../src/features/chat/chat-hydration-policy.ts";

test("hydrates a selected archived chat exactly once", () => {
  const selectedSummary = { id: "chat-1" };
  assert.equal(
    chatDetailHydrationId({ selectedSummary, threadSelected: false }),
    "chat-1",
  );
  assert.equal(
    chatDetailHydrationId({
      hydratedChatId: "chat-1",
      selectedSummary,
      threadSelected: false,
    }),
    undefined,
  );
});

test("skips hydration without a selection or when the transcript is present", () => {
  assert.equal(chatDetailHydrationId({ threadSelected: false }), undefined);
  assert.equal(
    chatDetailHydrationId({
      selectedSummary: { id: "chat-1" },
      threadSelected: true,
    }),
    undefined,
  );
  assert.equal(
    chatDetailHydrationId({
      selectedSummary: { handoffContext: "issue-1", id: "chat-1" },
      threadSelected: false,
    }),
    undefined,
  );
});

test("re-hydrates when the selection moves to another chat", () => {
  assert.equal(
    chatDetailHydrationId({
      hydratedChatId: "chat-1",
      selectedSummary: { id: "chat-2" },
      threadSelected: false,
    }),
    "chat-2",
  );
});
