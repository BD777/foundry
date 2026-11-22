// Claude Code validates every SDK hook callback's answer as a hook output
// object; anything else (`undefined` among it) is refused, reported as
// "Hook callback hook_N failed" and treated as empty. Every hook Foundry
// registers must answer with an object.
import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeTimerTracker } from "../dist/session/tasks/agent-timers.js";
import { ClaudeBackgroundTaskTracker } from "../dist/session/tasks/agent-background-tasks.js";
import {
  claudeFileWriteHooks,
  mergeClaudeHooks,
} from "../dist/session/files/session-files.js";
import { claudeWorkToolHooks } from "../dist/session/runner/claude-runtime-start.js";

const inputs = {
  PreToolUse: {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_use_id: "toolu_hook_answers",
    tool_input: { command: "true" },
  },
  PostToolUse: {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_use_id: "toolu_hook_answers",
    tool_input: { command: "true" },
    tool_response: { stdout: "", stderr: "" },
  },
  PostToolUseFailure: {
    hook_event_name: "PostToolUseFailure",
    tool_name: "Bash",
    tool_use_id: "toolu_hook_answers",
    tool_input: { command: "false" },
    error: "exit 1",
  },
  Stop: { hook_event_name: "Stop", stop_hook_active: false },
  UserPromptSubmit: { hook_event_name: "UserPromptSubmit", prompt: "hello" },
};

function sources() {
  const sink = {
    emit: () => undefined,
    isActiveTurn: () => true,
    sessionId: () => "sess_hook_answers",
  };
  return [
    claudeWorkToolHooks(() => "sess_hook_answers"),
    new ClaudeTimerTracker(sink, []).hooks(),
    new ClaudeBackgroundTaskTracker(sink).hooks(),
    claudeFileWriteHooks(
      () => undefined,
      () => undefined,
    ),
  ];
}

test("every Claude hook Foundry registers answers with an object", async () => {
  const hooks = mergeClaudeHooks(...sources());
  let called = 0;
  for (const [event, matchers] of Object.entries(hooks)) {
    const input = inputs[event];
    assert.ok(input, `no sample input for ${event}`);
    for (const [m, matcher] of matchers.entries())
      for (const [h, callback] of matcher.hooks.entries()) {
        const answer = await callback(input, input.tool_use_id, {
          signal: new AbortController().signal,
        });
        called++;
        assert.ok(
          answer !== null &&
            typeof answer === "object" &&
            !Array.isArray(answer),
          `${event} matcher ${m} hook ${h} answered ${JSON.stringify(answer)}`,
        );
      }
  }
  assert.ok(called >= 9, `only ${called} hooks ran`);
});
