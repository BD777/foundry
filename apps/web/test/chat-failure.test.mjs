import test from "node:test";
import assert from "node:assert/strict";
import { agentSessionFailureMessage } from "../src/features/chat/chat-failure.ts";
import { executionHostStoppedError } from "@bd777/foundry-protocol";
import { i18n } from "../src/i18n/index.ts";
import { chatMessagesForThread } from "../src/features/chat/chat-model.ts";
const at = "2026-10-23T04:00:00Z";
const warning = {
  id: "warn",
  at: "2026-10-23T04:07:25Z",
  label: "Notice",
  level: "warning",
  detail:
    "Codex 0.163.0 background inventory unavailable: Error: ENOSPC: no space left on device, write",
};
const session = {
  id: "sess_test",
  deviceId: "mac",
  workspaceId: "ws",
  agentId: "agent",
  provider: "codex",
  status: "failed",
  title: "test",
  prompt: "continue",
  input: { id: "turn", at, prompt: "continue" },
  startedAt: at,
  events: [],
  error: executionHostStoppedError,
};
const render = (extra = {}) =>
  agentSessionFailureMessage(
    { ...session, ...extra },
    executionHostStoppedError,
    [{ id: "mac", label: "My Mac" }],
  );

test("legacy restart shows device and unknown cause, never an invented disk cause", () => {
  const result = render();
  assert.match(result.title, /interrupted/);
  assert.match(result.text, /does not include why the service exited/);
  assert.equal(result.failureDiagnostic.location, "Execution device: My Mac");
  assert.equal(result.failureDiagnostic.observation, undefined);
  assert.equal(result.failureDiagnostic.details, executionHostStoppedError);
});
test("same-turn warning is qualified evidence; old turns, commands and commentary are excluded", () => {
  assert.match(
    render({ events: [warning] }).failureDiagnostic.observation,
    /not a confirmed cause/,
  );
  for (const events of [
    [{ ...warning, at: "2026-10-22T04:07:25Z" }],
    [
      warning,
      {
        at: "2026-10-23T04:08:00Z",
        label: "User message",
        level: "info",
        detail: "",
      },
    ],
    [{ ...warning, label: "Ran command" }],
    [{ ...warning, label: "Commentary" }],
  ])
    assert.equal(render({ events }).failureDiagnostic.observation, undefined);
  assert.equal(
    render({ events: [warning], completedAt: "2026-10-23T04:01:00Z" })
      .failureDiagnostic.observation,
    undefined,
  );
  assert.equal(
    render({ events: [warning], input: { id: "turn" }, startedAt: undefined })
      .failureDiagnostic.observation,
    undefined,
  );
});
test("structured diagnosis must match the current input and terminal error", () => {
  const event = {
    at: warning.at,
    label: "Session failed",
    level: "error",
    detail: "opaque native failure",
    metadata: {
      workerFailure: { version: 1, code: "disk_full", inputId: "turn" },
    },
  };
  const result = agentSessionFailureMessage(
    { ...session, events: [event] },
    event.detail,
  );
  assert.match(result.title, /disk space/);
  for (const metadata of [
    { workerFailure: { ...event.metadata.workerFailure, inputId: "old" } },
    { workerFailure: { version: 9, code: "disk_full", inputId: "turn" } },
  ]) {
    const fallback = agentSessionFailureMessage(
      { ...session, events: [{ ...event, metadata }] },
      event.detail,
    );
    assert.equal(fallback.title, "Run failed");
    assert.equal(fallback.text, event.detail);
  }
});
test("an unrecognized error stays the message instead of a generic cause", () => {
  const error =
    "There's an issue with the selected model (claude-opus-5-5). It may not exist or you may not have access to it.";
  const result = agentSessionFailureMessage(session, error, [
    { id: "mac", label: "My Mac" },
  ]);
  assert.equal(result.title, "Run failed");
  assert.equal(result.text, error);
  assert.equal(result.failureDiagnostic.location, undefined);
  assert.equal(result.failureDiagnostic.details, undefined);
  assert.match(result.failureDiagnostic.guidance, /Share this error/);
});
test("failure presentation reaches transcript and preserves turn-limit recovery", () => {
  const row = chatMessagesForThread(
    { sessions: [session], id: session.id, title: "test" },
    { devices: [{ id: "mac", label: "My Mac" }] },
  ).find((m) => m.kind === "failure");
  assert.equal(row.failureDiagnostic.location, "Execution device: My Mac");
  assert.equal(row.failureDiagnostic.details, executionHostStoppedError);
  const limit = agentSessionFailureMessage(
    { ...session, nativeSessionId: "native" },
    "maximum number of turns (12)",
  );
  assert.equal(limit.recoverable, true);
  assert.match(limit.text, /12 turns/);
});
test("Chinese presentation and provider failures use specific locations and recovery", async () => {
  await i18n.changeLanguage("zh-CN");
  try {
    assert.match(render().title, /执行设备/);
    const rate = agentSessionFailureMessage(
      session,
      "user tpm rate limit exceeded",
    );
    assert.equal(rate.failureDiagnostic.location, "故障位置：模型服务");
    assert.match(rate.failureDiagnostic.guidance, /额度恢复/);
  } finally {
    await i18n.changeLanguage("en");
  }
});
