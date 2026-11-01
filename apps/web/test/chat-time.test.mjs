import assert from "node:assert/strict";
import test from "node:test";
import {
  latestChatTime,
  chatUpdateLabel,
  chatUpdateTime,
} from "../src/features/chat/chat-time.ts";

test("a missing or invalid time reads as unknown, never as a raw label", () => {
  for (const value of [undefined, "invalid"]) {
    const display = chatUpdateTime(value);
    assert.equal(display.label, "Time unknown");
    assert.equal(display.dateTime, undefined);
  }
  const at = new Date(2026, 8, 8, 14, 5).toISOString();
  assert.equal(chatUpdateTime(at, new Date(2026, 8, 8, 15)).label, "14:05");
});

test("latest update uses the newest valid activity across sessions and native history", () => {
  assert.equal(
    latestChatTime([
      undefined,
      "invalid",
      "2026-09-08T06:00:00Z",
      "2026-09-07T08:00:00Z",
      "2026-09-08T07:00:00Z",
    ]),
    "2026-09-08T07:00:00.000Z",
  );
  assert.equal(latestChatTime([undefined, "invalid"]), undefined);
  assert.equal(chatUpdateLabel("invalid"), undefined);
});

test("update labels follow local calendar dates across midnight and year boundaries", () => {
  const now = new Date(2026, 0, 1, 0, 5);
  assert.equal(
    chatUpdateLabel(new Date(2026, 0, 1, 0, 0).toISOString(), now),
    "00:00",
  );
  assert.equal(
    chatUpdateLabel(new Date(2025, 11, 31, 23, 59).toISOString(), now),
    "yesterday",
  );
  assert.equal(
    chatUpdateLabel(new Date(2025, 11, 30, 23, 59).toISOString(), now),
    "2 days ago",
  );
  assert.equal(
    chatUpdateLabel(new Date(2025, 11, 1).toISOString(), now),
    "31 days ago",
  );
});

test("day labels remain calendar based across daylight saving changes", () => {
  assert.equal(
    chatUpdateLabel(
      new Date(2026, 2, 7, 23, 30).toISOString(),
      new Date(2026, 2, 9, 0, 5),
    ),
    "2 days ago",
  );
  assert.equal(
    chatUpdateLabel(
      new Date(2026, 9, 31, 23, 30).toISOString(),
      new Date(2026, 10, 2, 0, 5),
    ),
    "2 days ago",
  );
});
