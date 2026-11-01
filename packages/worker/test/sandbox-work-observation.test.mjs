import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordWorkToolStarting,
  recordWorkToolCompleted,
  sessionWork,
} from "../dist/session-work/supervisor.js";
import { emitForClaudeRuntime } from "../dist/runner/claude-messages.js";
import { ClaudeBackgroundTaskTracker } from "../dist/agent-background-tasks.js";

const backgroundTask = {
  id: "bsleep",
  provider: "claude",
  kind: "command",
  description: "Sleep 12 minutes",
  status: "running",
  startedAt: new Date().toISOString(),
  hasOutput: false,
};
// What a Claude runtime's trackers report while a session runs.
function observeClaudeWork(runtime) {
  for (const metadata of [
    { backgroundTaskSnapshot: [backgroundTask] },
    { timerSnapshot: [] },
    { taskId: "agent_1", taskType: "local_agent" },
    { timerFire: { id: "timer_1", origin: "scheduled" } },
  ])
    emitForClaudeRuntime(runtime, { label: "x", detail: "", metadata });
}
function claudeRuntime(sessionId) {
  return {
    closed: true,
    foundrySessionId: sessionId,
    input: { close: () => undefined },
    key: `runtime_${sessionId}`,
    lastUsed: Date.now(),
    nativeSessionId: `native_${sessionId}`,
  };
}

test("a sandboxed SDK observer never creates device-global supervisor state", (t) => {
  const root = mkdtempSync(join(tmpdir(), "sandbox-observer-"));
  const before = process.env.FOUNDRY_STATE_ROOT;
  t.after(() => {
    if (before === undefined) delete process.env.FOUNDRY_STATE_ROOT;
    else process.env.FOUNDRY_STATE_ROOT = before;
    rmSync(root, { recursive: true, force: true });
  });
  const blocked = join(root, "governance");
  writeFileSync(blocked, "not a directory");
  process.env.FOUNDRY_STATE_ROOT = blocked;
  assert.doesNotThrow(() => {
    recordWorkToolStarting("session", "tool");
    recordWorkToolCompleted("tool");
  });
  assert.equal(readFileSync(blocked, "utf8"), "not a directory");
});

// A verifier's SDK host runs read-only: its Bash task ending must not create
// the device's work state (ENOENT mkdir killed the host).
test("a sandboxed Claude host reports background tasks without creating supervisor state", (t) => {
  const root = mkdtempSync(join(tmpdir(), "sandbox-claude-work-"));
  const before = process.env.FOUNDRY_STATE_ROOT;
  t.after(() => {
    if (before === undefined) delete process.env.FOUNDRY_STATE_ROOT;
    else process.env.FOUNDRY_STATE_ROOT = before;
    rmSync(root, { recursive: true, force: true });
  });
  const blocked = join(root, "governance");
  writeFileSync(blocked, "not a directory");
  process.env.FOUNDRY_STATE_ROOT = blocked;
  const runtime = claudeRuntime("sess_verifier");
  const emitted = [];
  runtime.background = new ClaudeBackgroundTaskTracker({
    emit: (event) => {
      emitted.push(event);
      emitForClaudeRuntime(runtime, event);
    },
    sessionId: () => runtime.foundrySessionId,
  });
  assert.doesNotThrow(() => {
    observeClaudeWork(runtime);
    runtime.background.observe({
      type: "system",
      subtype: "task_started",
      task_id: "bsleep",
      tool_use_id: "toolu_bg",
      task_type: "local_bash",
      description: "Sleep 12 minutes",
      is_backgrounded: true,
    });
    runtime.background.close();
  });
  assert.equal(
    emitted.at(-1)?.metadata?.backgroundTaskSnapshot?.[0]?.stopReason,
    "agent_exit",
  );
  assert.equal(readFileSync(blocked, "utf8"), "not a directory");
});

test("the process that owns the supervisor still observes Claude work", (t) => {
  const root = mkdtempSync(join(tmpdir(), "owner-claude-work-"));
  const before = process.env.FOUNDRY_STATE_ROOT;
  t.after(() => {
    if (before === undefined) delete process.env.FOUNDRY_STATE_ROOT;
    else process.env.FOUNDRY_STATE_ROOT = before;
    rmSync(root, { recursive: true, force: true });
  });
  process.env.FOUNDRY_STATE_ROOT = root;
  sessionWork().attach(
    {
      id: "sess_owner",
      threadId: "sess_owner",
      workspaceId: "ws_owner",
      deviceId: "dev_owner",
    },
    root,
  );
  observeClaudeWork(claudeRuntime("sess_owner"));
  const inventory = JSON.parse(
    readFileSync(join(root, "session-work", "inventory.json"), "utf8"),
  );
  assert.ok(
    inventory.items.some(
      (item) => item.sessionId === "sess_owner" && item.sourceId === "bsleep",
    ),
  );
});
