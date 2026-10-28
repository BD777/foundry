import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
register("./bundler-resolve.mjs", import.meta.url);

const { defaultAgentChoice } =
  await import("../src/features/chat/chat-runtime-choice.ts");

const agents = [
  { id: "agent_claude", provider: "claude", profileId: "claude_local" },
  { id: "agent_codex", provider: "codex", profileId: "codex_local" },
];

test("a new chat starts from the resolved default agent with its model and effort", () => {
  assert.deepEqual(
    defaultAgentChoice(agents, {
      profileId: "codex_local",
      runtime: "codex",
      accountName: "Codex Local",
      accountSource: "workspace",
      model: "gpt-6",
      effort: "high",
    }),
    {
      agentId: "agent_codex",
      override: { model: "gpt-6", codexReasoningEffort: "high" },
    },
  );
  assert.deepEqual(
    defaultAgentChoice(agents, {
      profileId: "claude_local",
      runtime: "claude",
      accountName: "Claude Local",
      accountSource: "last_used",
      effort: "max",
    }),
    { agentId: "agent_claude", override: { claudeEffort: "max" } },
  );
});

test("a default no agent here runs leaves the composer as it was", () => {
  assert.equal(defaultAgentChoice(agents, undefined), undefined);
  assert.equal(
    defaultAgentChoice(agents, {
      profileId: "codex_local",
      runtime: "claude",
      accountName: "x",
      accountSource: "workspace",
    }),
    undefined,
  );
});
