import assert from "node:assert/strict";
import test from "node:test";
import {
  createResponseStreamEventIDAllocator,
  createSessionStatusEventFilter,
} from "../dist/session-helpers.js";

test("typed answers keep distinct event IDs and updates reuse their identity", () => {
  const allocate = createResponseStreamEventIDAllocator("s");
  const first = allocate("Response stream", "answer-1");
  assert.equal(allocate("Response stream", "answer-1"), first);
  const second = allocate("Response stream", "answer-2");
  assert.notEqual(first, second);
  assert.equal(allocate("Response stream", "answer-1"), first);
});

test("sends identical status heartbeats once per consecutive run", () => {
  const shouldSend = createSessionStatusEventFilter();
  const compacting = {
    label: "正在压缩上下文",
    detail: "Claude 正在整理会话上下文。",
    level: "info",
  };
  const requesting = { ...compacting, label: "正在请求模型" };
  assert.equal(shouldSend(compacting), true);
  assert.equal(shouldSend(compacting), false);
  assert.equal(shouldSend(requesting), true);
  assert.equal(shouldSend(requesting), false);
  assert.equal(shouldSend(compacting), true);
  assert.equal(shouldSend({ ...compacting, detail: "New progress" }), true);
  assert.equal(createSessionStatusEventFilter()(compacting), true);
});

test("keeps tools, responses, errors, and task metadata and resets status deduplication", () => {
  const status = { label: "正在压缩上下文", detail: "same", level: "info" };
  for (const event of [
    { ...status, label: "正在使用工具" },
    { ...status, label: "已使用工具" },
    { ...status, label: "Response stream" },
    { ...status, level: "error" },
    { ...status, metadata: { taskId: "task_1" } },
  ]) {
    const shouldSend = createSessionStatusEventFilter();
    assert.equal(shouldSend(status), true);
    assert.equal(shouldSend(status), false);
    assert.equal(shouldSend(event), true);
    assert.equal(shouldSend(event), true);
    assert.equal(shouldSend(status), true);
  }
});

test("response stream event ids advance after process events following text", () => {
  const nextID = createResponseStreamEventIDAllocator("sess_test");

  assert.equal(nextID("Response stream"), "evt_sess_test_response_stream");
  assert.equal(nextID("正在请求模型"), undefined);
  assert.equal(nextID("Response stream"), "evt_sess_test_response_stream");
  assert.equal(nextID("正在思考"), undefined);
  assert.equal(nextID("Response stream"), "evt_sess_test_response_stream_2");
});

test("response stream event ids advance after tools following text", () => {
  const nextID = createResponseStreamEventIDAllocator("sess_test");

  assert.equal(nextID("Response stream"), "evt_sess_test_response_stream");
  assert.equal(nextID("正在使用工具"), undefined);
  assert.equal(nextID("已使用工具"), undefined);
  assert.equal(nextID("Response stream"), "evt_sess_test_response_stream_2");
});
