import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./bundler-resolve.mjs", import.meta.url);
const { withNativeChatHistory } =
  await import("../src/features/chat/use-native-chat-history.ts");
const { profileTransitionNoteForSend } =
  await import("../src/features/chat/chat-session-model.ts");

const chat = {
  id: "native_codex_long",
  provider: "codex",
  profileId: "codex_local",
  profileLabel: "Codex Local",
  nativeSessionId: "long",
  title: "Long",
  preview: "",
  readonly: false,
  transcriptBefore: 300,
  transcript: [
    { id: "a2", kind: "assistant", text: "answer two" },
    { id: "u3", kind: "user", text: "third" },
  ],
};

test("earlier pages read back from the device come before what the chat carries", () => {
  const shown = withNativeChatHistory(chat, {
    chatId: chat.id,
    from: 300,
    // The page's last step is also the first the chat carries.
    transcript: [
      { id: "u1", kind: "user", text: "first" },
      { id: "a2", kind: "assistant", text: "answer two" },
    ],
    before: 0,
  });
  assert.deepEqual(
    shown.transcript.map((message) => message.id),
    ["u1", "a2", "u3"],
  );
  assert.equal(shown.transcriptBefore, 0, "the chat's start is reached");
});

test("pages read for another chat, or before the chat's latest part moved, are not shown", () => {
  const page = {
    chatId: chat.id,
    from: 300,
    transcript: [{ id: "u1", kind: "user", text: "first" }],
    before: 0,
  };
  assert.equal(
    withNativeChatHistory({ ...chat, transcriptBefore: 900 }, page).transcript
      .length,
    2,
  );
  assert.equal(
    withNativeChatHistory(chat, { ...page, chatId: "other" }).transcriptBefore,
    300,
  );
});

test("continuing a native chat under its own profile says nothing about a switch", () => {
  const agent = {
    id: "agent_codex",
    provider: "codex",
    profileId: "codex_local",
    profileLabel: "Codex Local",
  };
  assert.equal(
    profileTransitionNoteForSend({ agent, selectedChat: chat }),
    undefined,
  );
  assert.match(
    profileTransitionNoteForSend({
      agent: { ...agent, profileId: "gateway", profileLabel: "Gateway" },
      selectedChat: chat,
    }),
    /Codex Local.*Gateway/,
  );
});
