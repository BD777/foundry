import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./bundler-resolve.mjs", import.meta.url);
const { toolHandoffs, viewHandoff } =
  await import("../src/components/conversation/turn-handoffs.ts");
const { projectTranscript } =
  await import("../src/features/chat/thread/transcript-projection.ts");
const { assistantLines } =
  await import("../src/features/personal-agent/assistant-model.ts");

const json = (value) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
const claudeCall = (name, input) =>
  `mcp__foundry__${name}${input === undefined ? "" : `\n\n${json(input)}`}`;
const codexCall = (name, input, result) =>
  [
    `foundry.${name}`,
    input === undefined ? "" : `Arguments\n\n${json(input)}`,
    result === undefined ? "" : `Result\n\n${json(result)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
const step = (id, text, extra = {}) => ({
  id,
  callId: id,
  text,
  title: "Used tool",
  status: "completed",
  ...extra,
});
const at = (second) =>
  new Date(Date.UTC(2026, 10, 16, 8, 0, second)).toISOString();

test("a Claude create_session call names its title and project", () => {
  const [handoff] = toolHandoffs(
    [
      step(
        "call_1",
        claudeCall("create_session", {
          title: "Fix the login redirect",
          workspaceId: "ws_alpha",
          prompt: "Open the redirect handler and fix it.",
        }),
      ),
    ],
    "sess_parent",
  );
  assert.equal(handoff.kind, "create_session");
  assert.equal(handoff.fromSessionId, "sess_parent");
  assert.equal(handoff.title, "Fix the login redirect");
  assert.equal(handoff.workspaceId, "ws_alpha");
  assert.equal(handoff.sessionId, undefined);
  assert.equal(handoff.failed, undefined);
});

test("a result with the same call id links the created session and its status", () => {
  const [handoff] = toolHandoffs(
    [
      step(
        "call_1",
        claudeCall("create_session", {
          title: "Fix the login redirect",
          workspaceId: "ws_alpha",
          prompt: "Go.",
        }),
      ),
      step(
        "call_1",
        JSON.stringify({
          id: "sess_child",
          title: "Fix the login redirect",
          status: "running",
          workspaceId: "ws_alpha",
        }),
        { title: "Used tool" },
      ),
    ],
    "sess_parent",
  );
  assert.equal(handoff.sessionId, "sess_child");
  assert.equal(handoff.status, "running");
});

test("a Codex send_message names its target, title, project and delivery", () => {
  const [handoff] = toolHandoffs([
    step(
      "call_2",
      codexCall(
        "send_message",
        {
          sessionId: "sess_helper",
          prompt: "Continue.",
          delivery: "interrupt",
        },
        {
          id: "sess_helper",
          title: "Helper",
          status: "running",
          workspaceId: "ws_beta",
        },
      ),
    ),
  ]);
  assert.equal(handoff.kind, "send_message");
  assert.equal(handoff.sessionId, "sess_helper");
  assert.equal(handoff.title, "Helper");
  assert.equal(handoff.workspaceId, "ws_beta");
  assert.equal(handoff.delivery, "interrupt");
  assert.equal(handoff.status, "running");
});

test("the default send delivery is not shown, a boundary stays quiet", () => {
  const [handoff] = toolHandoffs([
    step(
      "call_2",
      codexCall("send_message", {
        sessionId: "sess_helper",
        prompt: "Continue.",
        delivery: "boundary",
      }),
    ),
  ]);
  assert.equal(handoff.delivery, undefined);
});

test("a dispatch names its item, project and continued session", () => {
  const [handoff] = toolHandoffs([
    step(
      "call_3",
      codexCall(
        "dispatch_item",
        {
          itemId: "item_1",
          workspaceId: "ws_gamma",
          sessionId: "sess_owner",
          stepKey: "step-1",
          prompt: "Do the step.",
        },
        {
          itemId: "item_1",
          workspaceId: "ws_gamma",
          sessionId: "sess_owner",
          status: "pending",
        },
      ),
    ),
  ]);
  assert.equal(handoff.kind, "dispatch_item");
  assert.equal(handoff.itemId, "item_1");
  assert.equal(handoff.workspaceId, "ws_gamma");
  assert.equal(handoff.sessionId, "sess_owner");
  assert.equal(handoff.status, "pending");
});

test("a failed call stays visible with a short reason", () => {
  const [handoff] = toolHandoffs([
    step(
      "call_4",
      [
        claudeCall("create_session", {
          title: "Forbidden",
          workspaceId: "ws_x",
        }),
        "Error",
        "",
        "not allowed: this assistant's permissions do not include project ws_x",
      ].join("\n\n"),
      { status: "failed", title: "Tool failed" },
    ),
  ]);
  assert.equal(handoff.failed, true);
  assert.match(handoff.failure, /not allowed/);
});

test("truncated tool input still names the fields before the cut", () => {
  const full = JSON.stringify({
    title: "Long task",
    workspaceId: "ws_delta",
    sessionId: "sess_delta",
    prompt: "x".repeat(4_000),
  });
  const [handoff] = toolHandoffs([
    step(
      "call_5",
      `mcp__foundry__send_message\n\n\`\`\`json\n${full.slice(0, full.indexOf("xxxx") + 5)}\n\n... truncated ...\n\`\`\``,
    ),
  ]);
  assert.equal(handoff.sessionId, "sess_delta");
  assert.equal(handoff.title, "Long task");
});

test("handoffs sit under the turn's last answer, not its process group", () => {
  const messages = projectTranscript(
    [
      { id: "u1", kind: "user", text: "Delegate it", at: at(0) },
      {
        ...step(
          "call_1",
          claudeCall("create_session", {
            title: "Delegated",
            workspaceId: "ws_alpha",
            prompt: "Go.",
          }),
        ),
        kind: "tool",
        at: at(1),
      },
      { id: "a1", kind: "assistant", text: "Started it.", at: at(2) },
      { id: "u2", kind: "user", text: "Thanks", at: at(3) },
      { id: "a2", kind: "assistant", text: "You are welcome.", at: at(4) },
    ],
    { sessionId: "sess_parent" },
  );
  assert.equal(messages[1].kind, "process");
  assert.equal(messages[1].handoffs, undefined);
  assert.equal(messages[2].text, "Started it.");
  assert.equal(messages[2].handoffs.length, 1);
  assert.equal(messages[2].handoffs[0].fromSessionId, "sess_parent");
  assert.equal(messages[4].text, "You are welcome.");
  assert.equal(messages[4].handoffs, undefined);
});

test("a created session is found as the turn's child when its result is absent", () => {
  const view = viewHandoff(
    {
      id: "call_1",
      kind: "create_session",
      fromSessionId: "sess_parent",
      title: "Delegated",
      workspaceId: "ws_alpha",
    },
    {
      childSession: (parentId, title, workspaceId) =>
        parentId === "sess_parent" &&
        title === "Delegated" &&
        workspaceId === "ws_alpha"
          ? {
              sessionId: "sess_child",
              title,
              workspaceId,
              status: "running",
            }
          : undefined,
      workspace: (id) => (id === "ws_alpha" ? "Alpha" : undefined),
    },
  );
  assert.equal(view.sessionId, "sess_child");
  assert.equal(view.workspace, "Alpha");
  assert.equal(view.status, "running");
});

test("a dispatch's item title comes from the assistant's list", () => {
  const view = viewHandoff(
    {
      id: "call_3",
      kind: "dispatch_item",
      itemId: "item_1",
      workspaceId: "ws_gamma",
      sessionId: "sess_owner",
    },
    {
      item: (id) => (id === "item_1" ? "Ship the release" : undefined),
      workspace: () => "Gamma",
      session: () => ({ title: "Owner" }),
    },
  );
  assert.equal(view.itemTitle, "Ship the release");
  assert.equal(view.workspace, "Gamma");
  assert.equal(view.sessionId, "sess_owner");
});

test("the assistant's home attaches a turn's handoff to its answer", () => {
  const session = {
    id: "sess_assistant",
    workspaceId: "ws_alpha",
    agentId: "agent_1",
    deviceId: "dev_1",
    provider: "claude",
    status: "completed",
    title: "Delegating",
    prompt: "Delegate it",
    input: { id: "in_1", prompt: "Delegate it" },
    response: "Started it.",
    createdLabel: "today",
    updatedLabel: "today",
    events: [
      {
        id: "evt_u",
        sessionId: "sess_assistant",
        at: at(0),
        label: "User message",
        detail: "",
        level: "info",
        message: { id: "in_1", kind: "user", text: "Delegate it", at: at(0) },
      },
      {
        id: "evt_t",
        sessionId: "sess_assistant",
        at: at(1),
        label: "Used tool",
        detail: "",
        level: "info",
        message: {
          id: "call_1",
          kind: "tool",
          callId: "call_1",
          status: "completed",
          title: "Used tool",
          text: claudeCall("create_session", {
            title: "Delegated",
            workspaceId: "ws_alpha",
            prompt: "Go.",
          }),
        },
      },
      {
        id: "evt_a",
        sessionId: "sess_assistant",
        at: at(2),
        label: "Response stream",
        detail: "",
        level: "info",
        message: {
          id: "a_1",
          kind: "assistant",
          text: "Started it.",
          at: at(2),
        },
      },
    ],
  };
  const answer = assistantLines([session]).find(
    (line) => line.role === "assistant",
  );
  assert.equal(answer.text, "Started it.");
  assert.equal(answer.handoffs.length, 1);
  assert.equal(answer.handoffs[0].title, "Delegated");
  assert.equal(answer.handoffs[0].fromSessionId, "sess_assistant");
});
