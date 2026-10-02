import assert from "node:assert/strict";
import test from "node:test";
import { agentSessionTerminalError } from "../src/features/chat/chat-session-model.ts";

const failed = {
  label: "Session failed",
  level: "error",
  detail: "Claude refused this turn",
};
const session = (status, events) => ({
  id: "sess_1",
  workspaceId: "ws_1",
  prompt: "Say hi.",
  provider: "claude",
  status,
  events,
});

test("the latest turn's failure ends the session", () => {
  assert.equal(
    agentSessionTerminalError(session("failed", [failed])),
    "Claude refused this turn",
  );
});

test("an earlier turn's failure no longer marks a session that went on", () => {
  const events = [
    failed,
    { label: "User message", level: "info", detail: "Try again." },
    { label: "Response stream", level: "info", detail: "done" },
  ];
  assert.equal(
    agentSessionTerminalError(session("completed", events)),
    undefined,
  );
  assert.equal(
    agentSessionTerminalError(session("failed", [...events, failed])),
    "Claude refused this turn",
  );
});
