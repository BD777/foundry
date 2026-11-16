import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./bundler-resolve.mjs", import.meta.url);
const { withoutRetiredUpkeepTurns } =
  await import("../src/features/personal-agent/assistant-model.ts");

const upkeepSource = { kind: "foundry_notice", noticeKind: "upkeep" };
const digestSource = { kind: "foundry_notice", noticeKind: "digest" };

function input(id, inputSource, extra = {}) {
  return {
    id,
    role: "person",
    text: `input ${id}`,
    at: "2026-11-16T04:00:00Z",
    ...(inputSource ? { inputSource } : {}),
    ...extra,
  };
}

function answer(id, text = `answer ${id}`) {
  return { id, role: "assistant", text, at: "2026-11-16T04:00:05Z" };
}

test("a retired upkeep notice and the answer it forced leave the view", () => {
  const lines = [
    input("p1", digestSource),
    answer("a1", "digest done"),
    input("n1", upkeepSource),
    answer("a2", "没有新情况"),
    input("p2"),
    answer("a3", "reply to the person"),
  ];
  assert.deepEqual(
    withoutRetiredUpkeepTurns(lines).map((line) => line.id),
    ["p1", "a1", "p2", "a3"],
  );
});

test("other notices and the person's own inputs stay visible", () => {
  const lines = [
    input("reminder", { kind: "foundry_notice", noticeKind: "reminder" }),
    answer("a1"),
    input("legacy", { kind: "foundry_notice" }),
    answer("a2"),
    input("person"),
    answer("a3"),
    input("session", { kind: "session", sessionId: "sess_other" }),
    answer("a4"),
  ];
  assert.deepEqual(withoutRetiredUpkeepTurns(lines), lines);
});

test("a hidden turn that opened a conversation hands the mark on", () => {
  const lines = [
    input("n1", upkeepSource, { startsConversation: true }),
    answer("a1"),
    input("p2"),
    answer("a2"),
  ];
  const shown = withoutRetiredUpkeepTurns(lines);
  assert.deepEqual(
    shown.map((line) => line.id),
    ["p2", "a2"],
  );
  assert.equal(shown[0].startsConversation, true);
});

test("a retired notice still awaiting its answer is hidden on its own", () => {
  const lines = [input("p1"), answer("a1"), input("n1", upkeepSource)];
  assert.deepEqual(
    withoutRetiredUpkeepTurns(lines).map((line) => line.id),
    ["p1", "a1"],
  );
});
