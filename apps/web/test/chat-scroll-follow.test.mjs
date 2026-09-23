import assert from "node:assert/strict";
import test from "node:test";
import {
  chatEffectiveScrollBehavior,
  chatViewportIsAtLatest,
  nextChatScrollFollowMode,
} from "../src/components/conversation/chat-scroll-follow.ts";

const viewport = (bottomGap) => ({
  clientHeight: 600,
  scrollHeight: 1600,
  scrollTop: 1000 - bottomGap,
});

test("treats the bottom tolerance as latest content", () => {
  assert.equal(chatViewportIsAtLatest(viewport(0)), true);
  assert.equal(chatViewportIsAtLatest(viewport(24)), true);
  assert.equal(chatViewportIsAtLatest(viewport(25)), false);
});

test("uses instant scrolling for long jumps to the latest message", () => {
  assert.equal(
    chatEffectiveScrollBehavior("smooth", viewport(240), false),
    "smooth",
  );
  assert.equal(
    chatEffectiveScrollBehavior(
      "smooth",
      { clientHeight: 600, scrollHeight: 5000, scrollTop: 1000 },
      false,
    ),
    "auto",
  );
  assert.equal(
    chatEffectiveScrollBehavior("smooth", viewport(0), true),
    "auto",
  );
});

test("content refreshes never override history-reading intent", () => {
  let mode = nextChatScrollFollowMode("following", {
    type: "user.scroll-intent",
  });
  assert.equal(mode, "reading");

  mode = nextChatScrollFollowMode(mode, { type: "content.resized" });
  assert.equal(mode, "reading");

  mode = nextChatScrollFollowMode(mode, {
    type: "viewport.scrolled",
    viewport: viewport(240),
  });
  assert.equal(mode, "reading");
});

test("following resumes only after an explicit request", () => {
  assert.equal(
    nextChatScrollFollowMode("reading", {
      type: "viewport.scrolled",
      viewport: viewport(12),
    }),
    "reading",
    "the visual bottom tolerance must not override explicit reading intent",
  );
  assert.equal(
    nextChatScrollFollowMode("reading", {
      type: "viewport.scrolled",
      viewport: viewport(0),
    }),
    "reading",
  );
  assert.equal(
    nextChatScrollFollowMode("reading", { type: "follow.requested" }),
    "following",
  );
  assert.equal(
    nextChatScrollFollowMode("reading", { type: "thread.changed" }),
    "following",
  );
});

test("history navigation cannot be canceled by the initial bottom read-back", () => {
  let mode = nextChatScrollFollowMode("following", {
    type: "history-navigation.requested",
  });
  assert.equal(mode, "navigating");

  mode = nextChatScrollFollowMode(mode, {
    type: "viewport.scrolled",
    viewport: viewport(0),
  });
  assert.equal(mode, "navigating");

  mode = nextChatScrollFollowMode(mode, {
    type: "viewport.scrolled",
    viewport: viewport(240),
  });
  assert.equal(mode, "reading");
});
