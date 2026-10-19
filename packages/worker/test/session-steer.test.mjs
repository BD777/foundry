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
const { noteSessionInput, steerActiveSession, steerActiveSessionOnce } =
  await import("../dist/session-helpers.js");
const { sessionPrompt, userMessageText } =
  await import("../dist/session-prompt.js");
const { activeClaudeRuntimes } = await import("../dist/session-state.js");
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

const profile = { id: "claude_local", runtime: "claude", label: "Claude" };

/** Starts a turn that stays open until something is steered into it. */
async function openTurn(session = chatSession(), { cwd, runtime } = {}) {
  cwd ??= join(root, `ws-${randomUUID()}`);
  mkdirSync(cwd, { recursive: true });
  const events = [];
  received.length = 0;
  const finished = runClaudeWorkspaceSession(
    cwd,
    session,
    runtime ?? profile,
    async (label, detail, level, metadata, message, eventId) =>
      events.push({ label, detail, message, eventId }),
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

test("a steer the server sends again is applied once, under its message's id", async () => {
  const { session, events, finished } = await openTurn();
  const id = randomUUID();
  // The server's wait ran out, and it sent the steer again.
  await Promise.all([
    steerActiveSessionOnce(session.id, id, "Also check mobile", []),
    steerActiveSessionOnce(session.id, id, "Also check mobile", []),
  ]);
  await finished;
  // Even once the turn ended, a repeat is answered as applied.
  await steerActiveSessionOnce(session.id, id, "Also check mobile", []);

  assert.deepEqual(received.slice(1), ["Also check mobile"]);
  const steered = events.filter(
    (event) => event.label === "Steered into active turn",
  );
  assert.equal(steered.length, 1);
  // Named like a sent message's input event, so the server can tell.
  assert.equal(steered[0].eventId, `evt_${id}`);
});

test("a refused steer with an id can be sent again", async () => {
  const session = chatSession();
  const id = randomUUID();
  // The turn has not started yet: refused, and not remembered as applied.
  await assert.rejects(
    steerActiveSessionOnce(session.id, id, "hello", []),
    /not accepting active steer input/,
  );
  const { finished } = await openTurn(session);
  await steerActiveSessionOnce(session.id, id, "hello", []);
  await finished;
  assert.deepEqual(received.slice(1), ["hello"]);
});

test("a late steer of a message the session took as an input of its own does not reach the agent", async () => {
  const session = chatSession();
  const id = randomUUID();
  // The server stopped waiting for the steer, and the person sent the
  // message again: it was dispatched as this input.
  session.input = { id, prompt: "Also check mobile" };
  noteSessionInput(session.id, id);
  const { events, finished } = await openTurn(session);
  await steerActiveSessionOnce(session.id, id, "Also check mobile", []);
  await steerActiveSession(session.id, "Something else", []);
  await finished;
  assert.deepEqual(received.slice(1), ["Something else"]);
  assert.equal(
    events.filter((event) => event.label === "Steered into active turn").length,
    1,
  );
});

test("configuration changes wait for a live owner while steering still reaches that owner", async () => {
  const session = chatSession();
  const cwd = join(root, `ws-${randomUUID()}`);
  const first = await openTurn(session, { cwd });
  const [earlier] = [...activeClaudeRuntimes.values()].filter(
    (runtime) => runtime.foundrySessionId === session.id,
  );
  assert.ok(earlier, "the first process is registered");
  await assert.rejects(
    runClaudeWorkspaceSession(
      cwd,
      {
        ...session,
        nativeSessionId: "steer-session",
        input: { id: randomUUID(), prompt: "changed configuration" },
      },
      { ...profile, model: "opus" },
      async () => {},
      async () => {},
      () => {},
    ),
    /active work/,
  );
  assert.equal(earlier.closed, false);
  await steerActiveSession(session.id, "Finish current work", []);
  assert.equal((await first.finished).response, "green");

  // After the old turn finishes, another model can safely resume its thread.
  const second = await openTurn(
    {
      ...session,
      nativeSessionId: "steer-session",
      input: { id: randomUUID(), prompt: "Run the long task" },
    },
    { cwd, runtime: { ...profile, model: "opus" } },
  );
  const writers = [...activeClaudeRuntimes.values()].filter(
    (runtime) => runtime.foundrySessionId === session.id,
  );
  assert.equal(writers.length, 1, "one process serves the session");
  assert.notEqual(writers[0], earlier);
  assert.notEqual(writers[0].key, earlier.key);
  assert.equal(earlier.closed, true);
  assert.equal(writers[0].closed, false);

  await steerActiveSession(session.id, "Go on", []);
  const result = await second.finished;
  assert.equal(result.response, "green");
  assert.deepEqual(received, [received[0], "Go on"]);
  assert.equal(activeClaudeRuntimes.get(writers[0].key), writers[0]);
});

test("inter-session inputs and Claude steers name the authenticated sender without changing transcript text", async () => {
  const { session, events, finished } = await openTurn();
  const sender = "sess_other_agent";
  const text = "Release the compute lease when finished.";
  await steerActiveSessionOnce(session.id, randomUUID(), text, [], sender);
  await finished;
  const prompt = sessionPrompt({
    ...session,
    input: { id: "next", prompt: text, sentBySessionId: sender },
  });
  assert.equal(received[1], prompt);
  assert.match(prompt, /another agent session \("sess_other_agent"\)/);
  assert.match(prompt, /not a message typed directly by the user/);
  assert.equal(
    events.find((event) => event.label === "Steered into active turn").detail,
    text,
  );
  assert.equal(userMessageText(text), text);
});

test("Codex active steer carries sender identity and preserves image input and transcript", async () => {
  const { runCodexStreamedTurn } =
    await import("../dist/runner/codex-stream.js");
  const id = `sess_${randomUUID()}`;
  let finish;
  const gate = new Promise((resolve) => {
    finish = resolve;
  });
  let receivedInput;
  const events = [];
  const thread = {
    runStreamed: async () => ({
      events: (async function* () {
        await gate;
      })(),
    }),
    steer: async (input) => {
      receivedInput = input;
    },
  };
  const running = runCodexStreamedTurn(
    { emit: async (...args) => events.push(args) },
    thread,
    "initial",
    id,
  );
  try {
    await steerActiveSessionOnce(
      id,
      "source-steer",
      "Please inspect",
      [image],
      "sess_sender",
    );
    assert.equal(
      receivedInput[0].text,
      userMessageText("Please inspect", [image], "sess_sender"),
    );
    assert.deepEqual(receivedInput[1], {
      type: "local_image",
      path: image.path,
    });
    assert.equal(events[0][4].text, "Please inspect");
  } finally {
    finish();
    await running;
  }
});

test("Codex terminal failure closes its producer and releases its writer before returning", async () => {
  const { runCodexStreamedTurn } =
    await import("../dist/runner/codex-stream.js");
  for (const cleanupFails of [false, true]) {
    let writerHeld = true;
    const notices = [];
    const thread = {
      runStreamed: async () => ({
        events: (async function* () {
          try {
            yield {
              type: "turn.failed",
              error: { message: "native upstream failed" },
            };
          } finally {
            writerHeld = false;
            if (cleanupFails) throw new Error("cleanup failed");
          }
        })(),
      }),
    };
    await assert.rejects(
      runCodexStreamedTurn(
        {
          emit: async (...event) => {
            notices.push(event);
          },
          eventsPath: join(root, `failed-${cleanupFails}.jsonl`),
          nativeSessionId: "",
          files: { recordToolWrite: async () => {} },
        },
        thread,
        "test",
        `sess_${randomUUID()}`,
      ),
      /native upstream failed/,
    );
    assert.equal(
      writerHeld,
      false,
      "failed turn left its native writer behind",
    );
    assert.equal(
      notices.some(
        (event) => event[0] === "Notice" && event[1].includes("cleanup failed"),
      ),
      cleanupFails,
    );
  }
});

test("Codex cannot report success when closing its producer fails", async () => {
  const { runCodexStreamedTurn } =
    await import("../dist/runner/codex-stream.js");
  const thread = {
    runStreamed: async () => ({
      events: (async function* () {
        try {
          yield { type: "turn.completed", usage: {} };
        } finally {
          throw new Error("writer release unconfirmed");
        }
      })(),
    }),
  };
  await assert.rejects(
    runCodexStreamedTurn(
      {
        emit: async () => {},
        eventsPath: join(root, "failed-close.jsonl"),
        files: { recordToolWrite: async () => {} },
        context: { read: async () => [], found: false },
      },
      thread,
      "test",
      `sess_${randomUUID()}`,
    ),
    /writer release unconfirmed/,
  );
});
