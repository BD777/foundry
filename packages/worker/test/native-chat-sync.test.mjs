import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "native-sync-"));
// Discovery must inspect only synthetic native homes, including cold worker processes.
process.env.HOME = root;
process.env.CODEX_HOME = join(root, "codex");
process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
const { initWorkspace } = await import("../dist/workspaces.js");
const { syncNativeChats } = await import("../dist/workspace-ops.js");

function notFound(response) {
  response.statusCode = 404;
  response.end("404 page not found");
}

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
        // A server older than the chat digest list.
        if (request.method === "GET") return notFound(response);
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
      if (request.method === "GET") return notFound(response);
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

test(
  "a chat the server never keeps is not sent again",
  { timeout: 60000 },
  async () => {
    const workspace = join(root, "ws-refused");
    mkdirSync(workspace);
    initWorkspace(workspace);
    // Its own config home: a listing of the shared one is reused for seconds.
    const previousHome = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = join(root, "claude-refused");
    const owned = "66666666-6666-6666-6666-666666666666";
    const other = "77777777-7777-7777-7777-777777777777";
    const ownedPath = session(workspace, owned, "a Foundry session's turn");
    const otherPath = session(workspace, other, "a terminal chat");
    const posts = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        if (request.method === "GET") return notFound(response);
        const post = JSON.parse(body);
        posts.push(post);
        response.setHeader("Content-Type", "application/json");
        // As the server answers a chat a Foundry session owns.
        const refused = post.chats
          .map((chat) => chat.id)
          .filter((id) => id === `native_claude_${owned}`);
        response.end(
          JSON.stringify({
            status: "synced",
            count: post.chats.length,
            refused,
          }),
        );
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const reply = (path) =>
      appendFileSync(
        path,
        `${JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { role: "assistant", content: `reply ${posts.length}` } })}\n`,
      );
    try {
      await syncNativeChats(url, workspace);
      assert.ok(posts.length > 0);
      posts.length = 0;
      reply(ownedPath);
      reply(otherPath);
      assert.equal(await syncNativeChats(url, workspace), 1);
      assert.deepEqual(
        posts.map((post) => post.chats.map((chat) => chat.id)),
        [[`native_claude_${other}`]],
        "the refused chat changed but is not sent",
      );
    } finally {
      process.env.CLAUDE_CONFIG_DIR = previousHome;
      server.close();
    }
  },
);

/** A worker process of its own (a restart): syncs once, returns the count. */
function syncInWorkerProcess(url, workspace, claudeHome) {
  const script = `
    const { syncNativeChats } = await import(${JSON.stringify(new URL("../dist/workspace-ops.js", import.meta.url).href)});
    console.log(JSON.stringify(await syncNativeChats(${JSON.stringify(url)}, ${JSON.stringify(workspace)})));`;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        env: { ...process.env, CLAUDE_CONFIG_DIR: claudeHome },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve(JSON.parse(out.trim().split("\n").at(-1)))
        : reject(new Error(`sync worker exited ${code}: ${err}`)),
    );
  });
}

/**
 * A server that records chat syncs and, when digests is given, answers the
 * chat digest list from what it holds.
 */
async function chatServer(t, digests) {
  const posts = [];
  const gets = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET") {
        gets.push(request.url);
        if (!digests) return notFound(response);
        return response.end(JSON.stringify({ chats: digests() }));
      }
      posts.push(JSON.parse(body));
      response.end(JSON.stringify({ status: "synced" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    posts,
    gets,
    /** Chat ids sent in full, in order. */
    full: () =>
      posts
        .filter((post) => post.chats.some((chat) => chat.transcript))
        .flatMap((post) => post.chats.map((chat) => chat.id)),
  };
}

function chatWorkspace(name) {
  const workspace = join(root, name);
  mkdirSync(workspace);
  initWorkspace(workspace);
  const claudeHome = join(root, `claude-${name}`);
  const write = (id, text) => {
    const dir = join(claudeHome, "projects", "p");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${id}.jsonl`);
    writeFileSync(
      path,
      `${JSON.stringify({ sessionId: id, cwd: workspace, type: "user", timestamp: "2026-10-01T00:00:00Z", message: { role: "user", content: text } })}\n`,
    );
    return path;
  };
  return { workspace, claudeHome, write };
}

const reply = (path, text, at = "2026-10-02T00:00:00Z") =>
  appendFileSync(
    path,
    `${JSON.stringify({ type: "assistant", timestamp: at, message: { role: "assistant", content: text } })}\n`,
  );

test(
  "a restarted worker sends only the chats that changed since its last upload",
  { timeout: 120000 },
  async (t) => {
    const { workspace, claudeHome, write } = chatWorkspace("ws-restart");
    const ids = [
      "88888888-8888-8888-8888-888888888881",
      "88888888-8888-8888-8888-888888888882",
    ];
    const paths = ids.map((id) => write(id, `hello ${id}`));
    const server = await chatServer(t);
    assert.equal(
      await syncInWorkerProcess(server.url, workspace, claudeHome),
      2,
    );
    assert.equal(server.full().length, 2);

    server.posts.length = 0;
    assert.equal(
      await syncInWorkerProcess(server.url, workspace, claudeHome),
      0,
      "a restart sent unchanged chats again",
    );
    assert.equal(server.posts.length, 0);

    reply(paths[1], "later");
    assert.equal(
      await syncInWorkerProcess(server.url, workspace, claudeHome),
      1,
    );
    assert.deepEqual(server.full(), [`native_claude_${ids[1]}`]);
  },
);

test(
  "the first run after an update sends only what the server lacks",
  { timeout: 120000 },
  async (t) => {
    // A worker before this one kept no record: its state root has none.
    const { workspace, claudeHome, write } = chatWorkspace("ws-upgrade");
    const same = "99999999-9999-9999-9999-999999999991";
    const newer = "99999999-9999-9999-9999-999999999992";
    const missing = "99999999-9999-9999-9999-999999999993";
    for (const id of [same, newer, missing])
      reply(write(id, `ask ${id}`), "answer");
    // What the previous worker uploaded, as the server reports it.
    const { nativeChatThreadsForWorkspace } =
      await import("../dist/native-chat.js");
    const previousHome = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    let listed;
    try {
      listed = await nativeChatThreadsForWorkspace(
        { id: "ws", localPath: workspace },
        [],
      );
    } finally {
      process.env.CLAUDE_CONFIG_DIR = previousHome;
    }
    const digestOf = (chat) => ({
      id: chat.id,
      updatedAt: chat.updatedAt,
      status: chat.status,
      answerRevision: chat.answerRevision,
      title: chat.title,
      preview: chat.preview,
      transcriptMessages: chat.transcript?.length ?? 0,
    });
    const held = listed
      .filter((chat) => chat.nativeSessionId !== missing)
      .map(digestOf)
      .map((digest) =>
        digest.id === `native_claude_${newer}`
          ? { ...digest, transcriptMessages: digest.transcriptMessages - 1 }
          : digest,
      );
    assert.equal(held.length, 2);
    const server = await chatServer(t, () => held);

    assert.equal(
      await syncInWorkerProcess(server.url, workspace, claudeHome),
      2,
    );
    assert.equal(server.gets.length, 1);
    assert.deepEqual(server.full().sort(), [
      `native_claude_${newer}`,
      `native_claude_${missing}`,
    ]);

    // Recorded now: a restart only checks the server still holds them.
    server.posts.length = 0;
    held.splice(0, held.length, ...listed.map(digestOf));
    assert.equal(
      await syncInWorkerProcess(server.url, workspace, claudeHome),
      0,
    );
    assert.equal(server.gets.length, 2);
    assert.equal(server.posts.length, 0);

    // A server that lost a chat (its data reset) gets it again.
    held.splice(
      held.findIndex((digest) => digest.id === `native_claude_${same}`),
      1,
    );
    assert.equal(
      await syncInWorkerProcess(server.url, workspace, claudeHome),
      1,
    );
    assert.deepEqual(server.full(), [`native_claude_${same}`]);
  },
);

test(
  "against a server without the digest list every chat is sent once, then recorded",
  { timeout: 120000 },
  async (t) => {
    const { workspace, claudeHome, write } = chatWorkspace("ws-old-server");
    reply(write("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1", "ask"), "answer");
    const server = await chatServer(t);
    assert.equal(
      await syncInWorkerProcess(server.url, workspace, claudeHome),
      1,
    );
    assert.equal(server.gets.length, 1);
    server.posts.length = 0;
    assert.equal(
      await syncInWorkerProcess(server.url, workspace, claudeHome),
      0,
    );
    assert.equal(server.posts.length, 0);
    // Each start asks once.
    assert.equal(server.gets.length, 2);
  },
);
