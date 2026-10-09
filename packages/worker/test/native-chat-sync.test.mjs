import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "native-sync-"));
process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
const { initWorkspace } = await import("../dist/workspaces.js");
const { syncNativeChats } = await import("../dist/workspace-ops.js");

function session(workspace, id, text) {
  const dir = join(process.env.CLAUDE_CONFIG_DIR, "projects", "p");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(
    path,
    `${JSON.stringify({ sessionId: id, cwd: workspace, type: "user", timestamp: "2026-10-01T00:00:00Z", message: { role: "user", content: text } })}\n`,
  );
  return path;
}

test(
  "native chat sync sends summaries once, then only chats that changed",
  { timeout: 60000 },
  async () => {
    const workspace = join(root, "ws");
    mkdirSync(workspace);
    initWorkspace(workspace);
    const paths = ["a", "b", "c"].map((id) =>
      session(
        workspace,
        `11111111-1111-1111-1111-11111111111${id === "a" ? 1 : id === "b" ? 2 : 3}`,
        `hello ${id}`,
      ),
    );
    const posts = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        posts.push(JSON.parse(body));
        response.setHeader("Content-Type", "application/json");
        response.end("{}");
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
      assert.equal(await syncNativeChats(url, workspace), 3);
      // One summary batch with every chat, then each chat in full.
      assert.equal(posts.length, 4);
      assert.equal(posts[0].chats.length, 3);
      assert.ok(posts[0].chats.every((chat) => chat.transcript === undefined));
      assert.ok(posts.slice(1).every((post) => post.chats.length === 1));

      posts.length = 0;
      assert.equal(await syncNativeChats(url, workspace), 0);
      assert.equal(posts.length, 0, "nothing changed, nothing sent");

      appendFileSync(
        paths[1],
        `${JSON.stringify({ type: "assistant", timestamp: "2026-10-02T00:00:00Z", message: { role: "assistant", content: "reply" } })}\n`,
      );
      assert.equal(await syncNativeChats(url, workspace), 1);
      assert.equal(posts.length, 1, "only the changed chat, in full");
    } finally {
      server.close();
    }
  },
);

test("a session's subagent and tool logs are not read as chats", async () => {
  const { nativeChatThreadsForWorkspace } =
    await import("../dist/native-chat.js");
  const workspace = join(root, "ws-depth");
  mkdirSync(workspace);
  const id = "22222222-2222-2222-2222-222222222222";
  session(workspace, id, "top level");
  const nested = join(
    process.env.CLAUDE_CONFIG_DIR,
    "projects",
    "p",
    id,
    "subagents",
  );
  mkdirSync(nested, { recursive: true });
  writeFileSync(
    join(nested, "agent-1.jsonl"),
    `${JSON.stringify({ sessionId: "33333333-3333-3333-3333-333333333333", cwd: workspace, type: "user", timestamp: "2026-10-01T00:00:00Z", message: { role: "user", content: "subagent" } })}\n`,
  );
  // Listings are reused for a few seconds; this test owns a fresh root.
  await new Promise((resolve) => setTimeout(resolve, 5100));
  const threads = await nativeChatThreadsForWorkspace(
    { id: "ws", name: "ws", localPath: workspace },
    [],
  );
  assert.ok(
    threads.every((thread) => !JSON.stringify(thread).includes("subagent")),
    "the subagent log was listed as a chat",
  );
  assert.equal(threads.length, 1);
});

test("a chat's time is its last message; bookkeeping and passing time change nothing", async () => {
  const { nativeChatThreadsForWorkspace } =
    await import("../dist/native-chat.js");
  const workspace = join(root, "ws-activity");
  mkdirSync(workspace);
  initWorkspace(workspace);
  // Its own config home: a listing of the shared one is reused for seconds.
  const previousHome = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude-activity");
  const id = "33333333-3333-3333-3333-333333333333";
  const asked = new Date(Date.now() - 5 * 60_000).toISOString();
  const path = session(workspace, id, "question");
  writeFileSync(
    path,
    [
      {
        sessionId: id,
        cwd: workspace,
        type: "user",
        timestamp: asked,
        message: { role: "user", content: "question" },
      },
      {
        sessionId: id,
        cwd: workspace,
        type: "assistant",
        timestamp: asked,
        message: { role: "assistant", content: "answer" },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n",
  );
  const posts = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      posts.push(JSON.parse(body));
      response.setHeader("Content-Type", "application/json");
      response.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const realNow = Date.now;
  try {
    assert.equal(await syncNativeChats(url, workspace), 1);
    // Claude Code closing the idle session appends bookkeeping records.
    appendFileSync(
      path,
      `${JSON.stringify({ type: "last-prompt", lastPrompt: "question", sessionId: id })}\n${JSON.stringify({ type: "ai-title", aiTitle: "Q", sessionId: id })}\n`,
    );
    const listed = await nativeChatThreadsForWorkspace(
      { id: "ws", localPath: workspace },
      [],
    );
    const chat = listed.find((item) => item.nativeSessionId === id);
    assert.ok(chat, JSON.stringify(listed.map((item) => item.id)));
    assert.equal(chat.updatedAt, asked);
    assert.equal(chat.updatedLabel, undefined);
    posts.length = 0;
    Date.now = () => realNow() + 3 * 60_000;
    assert.equal(await syncNativeChats(url, workspace), 0);
    assert.equal(posts.length, 0, "only time and bookkeeping changed");
  } finally {
    Date.now = realNow;
    process.env.CLAUDE_CONFIG_DIR = previousHome;
    server.close();
  }
});

test("a /resume stub is not a chat, and later system records don't move a chat's time", async () => {
  const { nativeChatThreadsForWorkspace } =
    await import("../dist/native-chat.js");
  const workspace = join(root, "ws-stub");
  mkdirSync(workspace);
  const previousHome = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude-stub");
  try {
    const dir = join(process.env.CLAUDE_CONFIG_DIR, "projects", "p");
    mkdirSync(dir, { recursive: true });
    const stub = "44444444-4444-4444-4444-444444444444";
    writeFileSync(
      join(dir, `${stub}.jsonl`),
      [
        { type: "permission-mode", permissionMode: "default", sessionId: stub },
        {
          type: "system",
          subtype: "local_command",
          content: "<command-name>/resume</command-name>",
          cwd: workspace,
          sessionId: stub,
          timestamp: new Date().toISOString(),
        },
        { type: "continued-in", sessionId: stub, continuedInSessionId: "x" },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
    );
    const real = "55555555-5555-5555-5555-555555555555";
    const asked = "2026-10-01T00:00:00.000Z";
    const path = session(workspace, real, "question");
    appendFileSync(
      path,
      `${JSON.stringify({ type: "system", subtype: "away_summary", content: "later", cwd: workspace, sessionId: real, timestamp: new Date().toISOString() })}\n`,
    );
    const listed = await nativeChatThreadsForWorkspace(
      { id: "ws", localPath: workspace },
      [],
    );
    assert.deepEqual(
      listed.map((item) => item.nativeSessionId),
      [real],
    );
    assert.equal(new Date(listed[0].updatedAt).toISOString(), asked);
  } finally {
    process.env.CLAUDE_CONFIG_DIR = previousHome;
  }
});
