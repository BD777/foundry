import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The runtime's config home is a scratch folder, set before modules read it.
const root = realpathSync(mkdtempSync(join(tmpdir(), "foundry-steer-")));
process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
const cli = join(root, "agent-cli");
writeFileSync(cli, "#!/bin/sh\necho 0.0.0-test\n", { mode: 0o755 });
process.env.FOUNDRY_CLAUDE_BIN = cli;
test.after(() => rmSync(root, { recursive: true, force: true }));

register("./fixtures/fake-steer-sdk-hooks.mjs", import.meta.url);
const { received } = await import("./fixtures/fake-steer-sdk.mjs");
const { closeAllActiveRuntimes, runClaudeWorkspaceSession } =
  await import("../dist/runner.js");
const { steerActiveSession } = await import("../dist/session-helpers.js");
const { sessionPrompt, userMessageText } =
  await import("../dist/session-prompt.js");
test.after(() => closeAllActiveRuntimes());

const image = {
  id: "att_green",
  name: "green.png",
  path: "/ws/.foundry/attachments/green.png",
  mimeType: "image/png",
  size: 326,
  kind: "image",
};

function chatSession() {
  const id = `sess_${randomUUID()}`;
  return {
    id,
    threadId: id,
    workspaceId: "ws",
    agentId: "agent",
    deviceId: "dev",
    provider: "claude",
    source: "chat",
    status: "running",
    title: "t",
    prompt: "Run the long task",
    createdLabel: "now",
    updatedLabel: "running",
    input: { id: randomUUID(), prompt: "Run the long task" },
  };
}

/** Starts a turn that stays open until something is steered into it. */
async function openTurn() {
  const cwd = join(root, `ws-${randomUUID()}`);
  mkdirSync(cwd, { recursive: true });
  const session = chatSession();
  const events = [];
  received.length = 0;
  const finished = runClaudeWorkspaceSession(
    cwd,
    session,
    { id: "claude_local", runtime: "claude", label: "Claude" },
    async (label, detail, level, metadata, message) =>
      events.push({ label, detail, message }),
    async () => {},
    () => {},
  );
  for (let waited = 0; received.length === 0; waited += 10) {
    if (waited > 5000) throw new Error("the turn never reached the agent");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { session, events, finished };
}

test("a steered message carries its image the way a sent message does", async () => {
  const { session, events, finished } = await openTurn();
  await steerActiveSession(session.id, "What color is this image?", [image]);
  await finished;

  const sent = sessionPrompt({
    ...session,
    input: {
      id: randomUUID(),
      prompt: "What color is this image?",
      attachments: [image],
    },
  });
  assert.equal(received[1], sent);
  assert.match(
    received[1],
    /<image name="green\.png" path="\/ws\/\.foundry\/attachments\/green\.png"><\/image>/,
  );
  assert.match(received[1], /What color is this image\?$/);

  // The transcript shows the message with its image.
  const steered = events.find(
    (event) => event.label === "Steered into active turn",
  );
  assert.equal(steered.detail, "What color is this image?");
  assert.equal(steered.message.kind, "user");
  assert.equal(steered.message.text, "What color is this image?");
  assert.deepEqual(steered.message.attachments, [image]);
  assert.match(steered.message.id, /^steer_/);
});

test("an image steers in without text; an empty steer is refused", async () => {
  const { session, events, finished } = await openTurn();
  await assert.rejects(
    steerActiveSession(session.id, "  ", []),
    /Steer message is required/,
  );
  await steerActiveSession(session.id, "", [image]);
  await finished;

  assert.equal(received[1], userMessageText("", [image]));
  assert.match(received[1], /<image name="green\.png"/);
  const steered = events.filter(
    (event) => event.label === "Steered into active turn",
  );
  assert.equal(steered.length, 1);
  assert.deepEqual(steered[0].message.attachments, [image]);
});
