import assert from "node:assert/strict";
import test from "node:test";
import {
  chatListMaxWidth,
  clampChatListWidth,
  persistChatListWidth,
  storedChatListWidth,
} from "../src/features/chat/chat-list-width.ts";

test("resizing reserves space for the conversation and bounds extreme widths", () => {
  assert.equal(chatListMaxWidth(1600), 640);
  assert.equal(chatListMaxWidth(1000), 500);
  assert.equal(clampChatListWidth(600, chatListMaxWidth(1000)), 500);
  assert.equal(clampChatListWidth(-100), 220);
  assert.equal(clampChatListWidth(10000), 640);
  assert.equal(clampChatListWidth(Number.NaN), 270);
});

test("stored preference survives temporary layout constraints and bad storage", (t) => {
  const previousWindow = globalThis.window;
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  const data = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => data.set(key, value),
    },
  };
  assert.equal(storedChatListWidth(), 270);
  persistChatListWidth(600);
  assert.equal(
    clampChatListWidth(storedChatListWidth(), chatListMaxWidth(800)),
    400,
  );
  assert.equal(
    storedChatListWidth(),
    600,
    "resizing the window must not overwrite the preference",
  );
  data.set("foundry.chatListWidth", "bad value");
  assert.equal(storedChatListWidth(), 270);
  Object.defineProperty(globalThis.window, "localStorage", {
    get() {
      throw new Error("Storage blocked");
    },
  });
  assert.equal(storedChatListWidth(), 270);
  assert.doesNotThrow(() => persistChatListWidth(400));
});
