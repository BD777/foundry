import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  utimes,
  rename,
  rm,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  archiveClaudeSession,
  archiveCodexThread,
  restoreClaudeSessionForResume,
  applyNativeArchive,
} from "../dist/native-archive.js";
import { codexHistoryRequest } from "../dist/codex-history.js";
import { resumeCodexThread } from "../dist/runner/codex-app-server.js";
import {
  nativeChatLogPath,
  nativeChatThreadsForWorkspace,
  invalidateNativeChatListings,
} from "../dist/native-chat.js";
const id = "11111111-1111-4111-8111-111111111111";
async function fixture(t, provider = "claude") {
  const home = await mkdtemp(join(tmpdir(), "foundry-native-archive-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const workspace = join(home, "workspace");
  await mkdir(workspace);
  const active =
    provider === "claude"
      ? join(home, "projects", "synthetic", `${id}.jsonl`)
      : join(
          home,
          "sessions",
          "2026",
          "10",
          "27",
          `rollout-2026-10-27T00-00-00-${id}.jsonl`,
        );
  const archived =
    provider === "claude"
      ? join(home, "archived_sessions", "projects", "synthetic", `${id}.jsonl`)
      : join(home, "archived_sessions", active.split("/").at(-1));
  await mkdir(dirname(active), { recursive: true });
  const rows =
    provider === "claude"
      ? [
          {
            type: "user",
            sessionId: id,
            cwd: workspace,
            timestamp: "2026-10-27T00:00:00Z",
            message: { role: "user", content: "synthetic archive prompt" },
          },
        ]
      : [
          {
            type: "session_meta",
            payload: { id, cwd: workspace, timestamp: "2026-10-27T00:00:00Z" },
          },
          {
            type: "event_msg",
            timestamp: "2026-10-27T00:01:00Z",
            payload: {
              type: "user_message",
              message: "synthetic archive prompt",
            },
          },
        ];
  await writeFile(
    active,
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  await utimes(active, new Date(0), new Date(0));
  return { home, workspace, active, archived };
}
test("Claude B preserves transcript, companion and manifest through idempotent round trip", async (t) => {
  const f = await fixture(t);
  const companion = f.active.slice(0, -6);
  await mkdir(companion);
  await writeFile(join(companion, "tool-result.txt"), "synthetic result");
  const before = await readFile(f.active);
  assert.equal(
    await archiveClaudeSession(f.home, id, "archived", {
      sessionId: "synthetic",
      inUse: async () => false,
    }),
    "archived",
  );
  assert.deepEqual(await readFile(f.archived), before);
  assert.equal(
    await readFile(join(f.archived.slice(0, -6), "tool-result.txt"), "utf8"),
    "synthetic result",
  );
  const manifest = JSON.parse(
    await readFile(
      f.archived.replace(/\.jsonl$/, ".foundry-archive.json"),
      "utf8",
    ),
  );
  assert.equal(manifest.originalPath, f.active);
  assert.equal(manifest.sessionId, "synthetic");
  assert.equal(await archiveClaudeSession(f.home, id, "archived"), "archived");
  await restoreClaudeSessionForResume(
    id,
    { CLAUDE_CONFIG_DIR: f.home },
    f.workspace,
  );
  assert.deepEqual(await readFile(f.active), before);
  assert.equal(await archiveClaudeSession(f.home, id, "active"), "active");
  await assert.rejects(stat(f.archived), { code: "ENOENT" });
});
test("Claude refuses recent writes, active owners, duplicate logs and companion conflicts without overwrites", async (t) => {
  const f = await fixture(t);
  await utimes(f.active, new Date(), new Date());
  await assert.rejects(archiveClaudeSession(f.home, id, "archived"), /in use/);
  await assert.rejects(
    archiveClaudeSession(f.home, id, "archived", { inUse: async () => true }),
    /in use/,
  );
  await mkdir(f.archived.slice(0, -6), { recursive: true });
  await assert.rejects(
    archiveClaudeSession(f.home, id, "archived", { inUse: async () => false }),
    /conflict/,
  );
  await writeFile(f.archived, "do not overwrite");
  await assert.rejects(
    archiveClaudeSession(f.home, id, "archived"),
    /duplicate/,
  );
  assert.equal(await readFile(f.archived, "utf8"), "do not overwrite");
});
test("Claude unarchive rejects destination conflicts and invalid manifest", async (t) => {
  const f = await fixture(t);
  await archiveClaudeSession(f.home, id, "archived", {
    inUse: async () => false,
  });
  await mkdir(f.active.slice(0, -6));
  await assert.rejects(
    archiveClaudeSession(f.home, id, "active", { inUse: async () => false }),
    /conflict/,
  );
  await rm(f.active.slice(0, -6), { recursive: true });
  await writeFile(
    f.archived.replace(/\.jsonl$/, ".foundry-archive.json"),
    JSON.stringify({
      version: 1,
      nativeSessionId: id,
      originalPath: "/outside",
    }),
  );
  await assert.rejects(
    archiveClaudeSession(f.home, id, "active", { inUse: async () => false }),
    /manifest/,
  );
  assert.ok(await stat(f.archived));
});
test("Codex archive/unarchive checks state and is idempotent", async (t) => {
  const f = await fixture(t, "codex");
  const calls = [];
  const client = {
    request: async (method) => {
      if (method === "thread/list") return { data: [], nextCursor: null };
      calls.push(method);
      await mkdir(dirname(f.archived), { recursive: true });
      await rename(
        method === "thread/archive" ? f.active : f.archived,
        method === "thread/archive" ? f.archived : f.active,
      );
      return {};
    },
  };
  const env = { CODEX_HOME: f.home };
  assert.equal(
    await archiveCodexThread(client, id, "archived", env),
    "archived",
  );
  assert.equal(
    await archiveCodexThread(client, id, "archived", env),
    "archived",
  );
  assert.equal(await archiveCodexThread(client, id, "active", env), "active");
  assert.equal(await archiveCodexThread(client, id, "active", env), "active");
  assert.deepEqual(calls, ["thread/archive", "thread/unarchive"]);
});
test("Codex archive shares restricted stale alias repair and validates native identity", async (t) => {
  const f = await fixture(t, "codex");
  await writeFile(
    f.active,
    JSON.stringify({
      type: "session_meta",
      payload: { id, cwd: f.workspace, instructions: "x".repeat(300_000) },
    }) + "\n",
  );
  const parent = join(f.home, "managed", "codex");
  await mkdir(parent, { recursive: true });
  const indexed = join(
    parent,
    "a".repeat(24),
    "sessions",
    "2026",
    "10",
    "27",
    f.active.split("/").at(-1),
  );
  const env = {
    CODEX_HOME: join(parent, "b".repeat(24)),
    FOUNDRY_NATIVE_CODEX_DATA_HOME: f.home,
    FOUNDRY_RUNTIME_CONFIG_ISOLATED: "1",
  };
  const client = {
    request: async (method) => {
      if (method === "thread/read") return { thread: { id, path: indexed } };
      try {
        await stat(indexed);
      } catch {
        throw new Error(`no rollout found for thread id ${id}`);
      }
      return {};
    },
  };
  await codexHistoryRequest(client, { threadId: id }, env, "thread/archive");
  assert.ok(
    (await lstat(join(parent, "a".repeat(24), "sessions"))).isSymbolicLink(),
  );
  await assert.rejects(stat(join(parent, "a".repeat(24), "config.toml")), {
    code: "ENOENT",
  });
});
test("Codex resume restores externally archived copy and propagates other errors", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "foundry-resume-guard-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { CODEX_HOME: home };
  const calls = [];
  let archived = true;
  const client = {
    request: async (method) => {
      if (method === "thread/list") return { data: [], nextCursor: null };
      calls.push(method);
      if (method === "thread/unarchive") {
        archived = false;
        return {};
      }
      if (archived)
        throw new Error(`session ${id} is archived. Run codex unarchive`);
      return { thread: { id } };
    },
  };
  assert.equal(
    (await resumeCodexThread(client, { threadId: id }, env)).thread.id,
    id,
  );
  assert.deepEqual(calls, [
    "thread/resume",
    "thread/unarchive",
    "thread/resume",
  ]);
  await assert.rejects(
    resumeCodexThread(
      {
        request: async () => {
          throw new Error("permission denied");
        },
      },
      { threadId: id },
      {},
    ),
    /permission denied/,
  );
});
test("archived native logs remain discoverable and readable in their workspace", async (t) => {
  for (const provider of ["claude", "codex"]) {
    const f = await fixture(t, provider);
    await mkdir(dirname(f.archived), { recursive: true });
    await rename(f.active, f.archived);
    const key = provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
    const prior = process.env[key];
    const priorHome = process.env.HOME;
    const otherKey = provider === "claude" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
    const priorOther = process.env[otherKey];
    process.env[otherKey] = f.home;
    process.env.HOME = f.home;
    process.env[key] = f.home;
    try {
      invalidateNativeChatListings();
      assert.equal(
        await nativeChatLogPath(f.workspace, provider, id),
        f.archived,
      );
      assert.equal(
        await nativeChatLogPath("/other-workspace", provider, id),
        undefined,
      );
      const chats = await nativeChatThreadsForWorkspace(
        { id: "scratch", localPath: f.workspace },
        [],
      );
      assert.equal(
        chats.find(
          (chat) => chat.nativeSessionId === id && chat.provider === provider,
        )?.archived,
        true,
      );
      assert.equal(
        (
          await nativeChatThreadsForWorkspace(
            { id: "scratch", localPath: f.workspace },
            [],
            0,
          )
        ).length,
        1,
        "archived chats bypass recent limit",
      );
      await rename(f.archived, f.active);
      invalidateNativeChatListings();
      const restored = await nativeChatThreadsForWorkspace(
        { id: "scratch", localPath: f.workspace },
        [],
        0,
        new Set([`native_${provider}_${id}`]),
      );
      assert.equal(restored.length, 1);
      assert.equal(
        restored[0].archived,
        false,
        "previously archived chats remain watched after restore",
      );
    } finally {
      if (priorOther === undefined) delete process.env[otherKey];
      else process.env[otherKey] = priorOther;
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
  }
});
test("dispatch rejects in-use sessions and stale archive generations", async () => {
  const item = {
    provider: "claude",
    nativeSessionId: "synthetic-generation-test",
    deviceId: "scratch",
    workspacePath: "/scratch",
    desired: "archived",
    generation: 2,
  };
  assert.match((await applyNativeArchive(item, true)).error, /in use/);
  const stale = await applyNativeArchive({
    ...item,
    desired: "active",
    generation: 1,
  });
  assert.equal(stale.state, "pending");
  assert.match(stale.error, /Superseded/);
});

test("Codex cascade manifest restores only descendants active before archive and survives retry", async (t) => {
  const f = await fixture(t, "codex");
  const child = "22222222-2222-4222-8222-222222222222";
  const old = "33333333-3333-4333-8333-333333333333";
  const activeChild = f.active.replace(id, child);
  const archivedChild = f.archived.replace(id, child);
  const oldArchived = f.archived.replace(id, old);
  await writeFile(
    activeChild,
    JSON.stringify({
      type: "session_meta",
      payload: {
        id: child,
        source: {
          subagent: { thread_spawn: { parent_thread_id: id, depth: 1 } },
        },
      },
    }) + "\n",
  );
  await mkdir(dirname(oldArchived), { recursive: true });
  await writeFile(
    oldArchived,
    JSON.stringify({
      type: "session_meta",
      payload: { id: old, parent_thread_id: id },
    }) + "\n",
  );
  const env = { CODEX_HOME: f.home };
  let fail = true;
  const calls = [];
  const client = {
    request: async (method, params) => {
      if (method === "thread/list")
        return {
          data: [
            { id, source: "cli" },
            {
              id: child,
              source: { subAgent: { thread_spawn: { parent_thread_id: id } } },
            },
          ],
          nextCursor: null,
        };
      calls.push([method, params.threadId]);
      if (method === "thread/archive") {
        if (fail) {
          fail = false;
          throw new Error("synthetic archive failure");
        }
        await rename(f.active, f.archived);
        await rename(activeChild, archivedChild);
        return {};
      }
      if (method === "thread/unarchive") {
        await rename(
          params.threadId === id ? f.archived : archivedChild,
          params.threadId === id ? f.active : activeChild,
        );
        return {};
      }
      throw new Error("unexpected method");
    },
  };
  const manifest = join(
    f.home,
    "archived_sessions",
    ".foundry-archive",
    `${id}.json`,
  );
  await assert.rejects(
    archiveCodexThread(client, id, "archived", env),
    /synthetic archive failure/,
  );
  assert.deepEqual(
    JSON.parse(await readFile(manifest, "utf8")).activeDescendantIds,
    [child],
  );
  const reported = [];
  await archiveCodexThread(client, id, "archived", env, (ids) =>
    reported.push(...ids),
  );
  await archiveCodexThread(client, id, "archived", env);
  assert.deepEqual(reported, [child]);
  assert.deepEqual(
    JSON.parse(await readFile(manifest, "utf8")).activeDescendantIds,
    [child],
  );
  await archiveCodexThread(client, id, "active", env);
  assert.ok(await stat(f.active));
  assert.ok(await stat(activeChild));
  assert.ok(await stat(oldArchived));
  assert.equal(
    calls.filter(
      ([method, thread]) => method === "thread/unarchive" && thread === old,
    ).length,
    0,
  );
  await assert.rejects(stat(manifest), { code: "ENOENT" });
});

test(
  "installed Codex archives a scratch cascade and restores only recorded descendants",
  { timeout: 60000 },
  async (t) => {
    const { promisify } = await import("node:util");
    const { execFile } = await import("node:child_process");
    try {
      await promisify(execFile)("codex", ["--version"], { timeout: 10000 });
    } catch {
      t.skip("Codex CLI is not installed");
      return;
    }
    const { CodexAppServer } =
      await import("../dist/agent-runtime/codex-client.js");
    const f = await fixture(t, "codex");
    const child = "44444444-4444-4444-8444-444444444444";
    const old = "55555555-5555-4555-8555-555555555555";
    const activeChild = f.active.replace(id, child),
      archivedChild = f.archived.replace(id, child),
      oldArchived = f.archived.replace(id, old);
    await mkdir(dirname(f.archived), { recursive: true });
    for (const [thread, path, source] of [
      [id, f.active, "cli"],
      [
        child,
        activeChild,
        { subagent: { thread_spawn: { parent_thread_id: id, depth: 1 } } },
      ],
      [
        old,
        oldArchived,
        { subagent: { thread_spawn: { parent_thread_id: id, depth: 1 } } },
      ],
    ]) {
      await writeFile(
        path,
        [
          {
            timestamp: "2026-10-27T00:00:00.000Z",
            type: "session_meta",
            payload: {
              id: thread,
              timestamp: "2026-10-27T00:00:00.000Z",
              cwd: f.workspace,
              originator: "codex_cli_rs",
              cli_version: "0.163.0",
              source,
              model_provider: "openai",
            },
          },
          {
            timestamp: "2026-10-27T00:00:01.000Z",
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: "Synthetic local archive test; no inference",
                },
              ],
            },
          },
        ]
          .map((row) => JSON.stringify(row))
          .join("\n") + "\n",
      );
    }
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/^(FOUNDRY_NATIVE_|CODEX_|OPENAI_|ANTHROPIC_)/.test(key),
      ),
    );
    Object.assign(env, { HOME: f.home, CODEX_HOME: f.home });
    const client = new CodexAppServer("codex", env, f.workspace);
    try {
      for (const thread of [id, child, old])
        await client.request("thread/read", {
          threadId: thread,
          includeTurns: false,
        });
      const reported = [];
      await archiveCodexThread(client, id, "archived", env, (ids) =>
        reported.push(...ids),
      );
      assert.deepEqual(reported, [child]);
      assert.ok(await stat(archivedChild));
      assert.ok(await stat(oldArchived));
      await archiveCodexThread(client, id, "archived", env);
      await archiveCodexThread(client, id, "active", env);
      assert.ok(await stat(f.active));
      assert.ok(await stat(activeChild));
      assert.ok(await stat(oldArchived));
      await archiveCodexThread(client, id, "active", env);
    } finally {
      await client.close();
    }
  },
);

test("native archive dry run reports descendants without moving files or writing manifests", async (t) => {
  const f = await fixture(t, "codex");
  const child = "66666666-6666-4666-8666-666666666666";
  await writeFile(
    f.active.replace(id, child),
    JSON.stringify({
      type: "session_meta",
      payload: {
        id: child,
        source: {
          subagent: { thread_spawn: { parent_thread_id: id, depth: 1 } },
        },
      },
    }) + "\n",
  );
  const { nativeSourceKeys } = await import("../dist/native-runtime-paths.js");
  const keys = ["HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", ...nativeSourceKeys];
  const prior = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, {
    HOME: f.home,
    CODEX_HOME: f.home,
    CLAUDE_CONFIG_DIR: f.home,
  });
  try {
    const item = {
      provider: "codex",
      nativeSessionId: id,
      deviceId: "scratch",
      workspacePath: f.workspace,
      desired: "archived",
      generation: 0,
    };
    const result = await applyNativeArchive(item, false, true);
    assert.equal(result.state, "active");
    assert.deepEqual(result.nativeDescendantIds, [child]);
    assert.ok(await stat(f.active));
    assert.ok(await stat(f.active.replace(id, child)));
    await assert.rejects(stat(join(f.home, "archived_sessions")), {
      code: "ENOENT",
    });
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("owned native refusal cache sends archive changes as summaries and keeps transcript dedupe", async (t) => {
  const f = await fixture(t);
  const { initWorkspace } = await import("../dist/workspaces.js");
  const { syncNativeChats } = await import("../dist/workspace-ops.js");
  const { createServer } = await import("node:http");
  const keys = ["HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"];
  const prior = new Map(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    HOME: f.home,
    CODEX_HOME: f.home,
    CLAUDE_CONFIG_DIR: f.home,
  });
  initWorkspace(f.workspace);
  const posts = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      if (request.method === "GET") {
        response.statusCode = 404;
        response.end();
        return;
      }
      const payload = JSON.parse(body);
      posts.push(payload);
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({ refused: payload.chats.map((chat) => chat.id) }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    invalidateNativeChatListings();
    assert.equal(await syncNativeChats(url, f.workspace), 1);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].chats[0].transcript, undefined);
    posts.length = 0;
    assert.equal(await syncNativeChats(url, f.workspace), 0);
    assert.equal(posts.length, 0);
    await mkdir(dirname(f.archived), { recursive: true });
    await rename(f.active, f.archived);
    invalidateNativeChatListings();
    await syncNativeChats(url, f.workspace);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].chats[0].archived, true);
    assert.equal(posts[0].chats[0].transcript, undefined);
    assert.equal(posts[0].chats[0].recentMessages, undefined);
    posts.length = 0;
    await syncNativeChats(url, f.workspace);
    assert.equal(posts.length, 0);
    await rename(f.archived, f.active);
    invalidateNativeChatListings();
    await syncNativeChats(url, f.workspace);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].chats[0].archived, false);
    assert.equal(posts[0].chats[0].transcript, undefined);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("Codex discovery follows ancestry through pre-archived subagents without restoring them", async (t) => {
  const f = await fixture(t, "codex");
  const middle = "77777777-7777-4777-8777-777777777777",
    grandchild = "88888888-8888-4888-8888-888888888888";
  await mkdir(dirname(f.archived), { recursive: true });
  for (const [thread, parent, path] of [
    [middle, id, f.archived.replace(id, middle)],
    [grandchild, middle, f.active.replace(id, grandchild)],
  ])
    await writeFile(
      path,
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: thread,
          source: {
            subagent: { thread_spawn: { parent_thread_id: parent, depth: 1 } },
          },
        },
      }) + "\n",
    );
  const { codexDescendants } = await import("../dist/native-archive.js");
  assert.deepEqual(await codexDescendants(f.home, id), [grandchild]);
});

test("external Claude stable data homes support archive, discovery and history without invoking adapters", async (t) => {
  const f = await fixture(t);
  const { externalConnectionDataHome } =
    await import("../dist/session-ambient.js");
  const { deviceAgentProfilesPath } = await import("../dist/profiles.js");
  const { nativeChatHistory, claudeHomeCandidates } =
    await import("../dist/native-chat.js");
  const previousProfiles = await readFile(deviceAgentProfilesPath).catch(
    (error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  const profile = {
    id: "synthetic_external_archive",
    label: "Synthetic external archive",
    runtime: "claude",
    connectionType: "external",
    externalConnection: {
      identity: "synthetic-connection-identity",
      executable: join(f.home, "must-not-run"),
    },
  };
  const marker = join(f.home, "adapter-invoked");
  await writeFile(
    profile.externalConnection.executable,
    `#!/bin/sh\ntouch '${marker}'\nexit 1\n`,
    { mode: 0o700 },
  );
  const home = externalConnectionDataHome(profile);
  await assert.rejects(stat(home), { code: "ENOENT" });
  const active = join(home, "projects", "synthetic", `${id}.jsonl`);
  const archived = join(
    home,
    "archived_sessions",
    "projects",
    "synthetic",
    `${id}.jsonl`,
  );
  await mkdir(dirname(active), { recursive: true });
  await rename(f.active, active);
  await mkdir(active.slice(0, -6));
  await writeFile(
    join(active.slice(0, -6), "tool-result.txt"),
    "external companion",
  );
  await mkdir(dirname(deviceAgentProfilesPath), { recursive: true });
  await writeFile(
    deviceAgentProfilesPath,
    JSON.stringify({ profiles: [profile] }),
  );
  const keys = ["HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"];
  const prior = new Map(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    HOME: f.home,
    CODEX_HOME: f.home,
    CLAUDE_CONFIG_DIR: f.home,
  });
  const item = {
    provider: "claude",
    nativeSessionId: id,
    profileId: profile.id,
    deviceId: "scratch",
    workspacePath: f.workspace,
    desired: "archived",
    generation: 100,
  };
  try {
    assert.ok(claudeHomeCandidates().includes(home));
    invalidateNativeChatListings();
    const before = await nativeChatThreadsForWorkspace(
      { id: "scratch", localPath: f.workspace },
      [],
    );
    assert.equal(
      before.find((chat) => chat.nativeSessionId === id)?.profileId,
      profile.id,
    );
    const dryRun = await applyNativeArchive(item, false, true);
    assert.equal(dryRun.state, "active", dryRun.error);
    await assert.rejects(stat(join(home, "archived_sessions")), {
      code: "ENOENT",
    });
    const archivedResult = await applyNativeArchive(item);
    assert.equal(archivedResult.state, "archived", archivedResult.error);
    assert.equal(await nativeChatLogPath(f.workspace, "claude", id), archived);
    assert.ok(
      (
        await nativeChatHistory(
          f.workspace,
          "claude",
          id,
          (await stat(archived)).size,
        )
      ).transcript.length > 0,
    );
    const chats = await nativeChatThreadsForWorkspace(
      { id: "scratch", localPath: f.workspace },
      [],
    );
    assert.equal(
      chats.find((chat) => chat.nativeSessionId === id)?.archived,
      true,
    );
    // Removed/disabled connections must not make existing archived history vanish.
    await writeFile(deviceAgentProfilesPath, JSON.stringify({ profiles: [] }));
    assert.ok(claudeHomeCandidates().includes(home));
    assert.equal(await nativeChatLogPath(f.workspace, "claude", id), archived);
    const restored = await applyNativeArchive({
      ...item,
      desired: "active",
      generation: 101,
    });
    assert.equal(restored.state, "active", restored.error);
    assert.equal(
      await readFile(join(active.slice(0, -6), "tool-result.txt"), "utf8"),
      "external companion",
    );
    await assert.rejects(stat(marker), { code: "ENOENT" });
  } finally {
    if (previousProfiles === undefined)
      await rm(deviceAgentProfilesPath, { force: true });
    else await writeFile(deviceAgentProfilesPath, previousProfiles);
    await rm(home, { recursive: true, force: true });
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("Claude resume guard leaves already-active history validation to the native runtime", async (t) => {
  const f = await fixture(t);
  await writeFile(f.active, "{}\n");
  await restoreClaudeSessionForResume(
    id,
    { CLAUDE_CONFIG_DIR: f.home },
    f.workspace,
  );
  assert.equal(await readFile(f.active, "utf8"), "{}\n");
  await assert.rejects(stat(join(f.home, "archived_sessions")), {
    code: "ENOENT",
  });
});

test("resume lock waits for daemon restore and rechecks Claude state", async (t) => {
  const { acquireNativeArchiveLock } =
    await import("../dist/native-archive.js");
  const f = await fixture(t);
  await archiveClaudeSession(f.home, id, "archived", {
    inUse: async () => false,
  });
  const lock = join(f.home, "archived_sessions", ".locks", id);
  const release = await acquireNativeArchiveLock(lock);
  const waiting = restoreClaudeSessionForResume(
    id,
    { CLAUDE_CONFIG_DIR: f.home },
    f.workspace,
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  await rename(f.archived, f.active);
  await rm(f.archived.replace(/\.jsonl$/, ".foundry-archive.json"));
  await release();
  await waiting;
  assert.ok(await stat(f.active));
  await assert.rejects(stat(f.archived), { code: "ENOENT" });
});

test("archive locks recover dead owners and old incomplete locks but retain live owners", async (t) => {
  const { acquireNativeArchiveLock } =
    await import("../dist/native-archive.js");
  const { spawn } = await import("node:child_process");
  const f = await fixture(t);
  const lock = join(f.home, "locks", id);
  await mkdir(lock, { recursive: true });
  const dead = spawn(process.execPath, ["-e", ""]);
  await new Promise((resolve) => dead.once("exit", resolve));
  await writeFile(
    join(lock, "owner.json"),
    JSON.stringify({ pid: dead.pid, createdAt: Date.now() }),
  );
  await mkdir(`${lock}.reap`);
  await writeFile(
    join(`${lock}.reap`, "owner.json"),
    JSON.stringify({ pid: dead.pid, createdAt: Date.now() }),
  );
  const release = await acquireNativeArchiveLock(lock);
  const owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8"));
  assert.equal(owner.pid, process.pid);
  assert.ok(owner.createdAt > 0);
  await writeFile(
    join(lock, "owner.json"),
    JSON.stringify({ ...owner, createdAt: 1 }),
  );
  await utimes(lock, new Date(0), new Date(0));
  const start = Date.now();
  await assert.rejects(acquireNativeArchiveLock(lock, 150), (error) =>
    error.message.includes(lock),
  );
  assert.ok(Date.now() - start >= 140);
  await release();
  await mkdir(lock);
  await assert.rejects(acquireNativeArchiveLock(lock), /owns the lock/);
  const future = new Date(Date.now() + 86400_000);
  await utimes(lock, future, future);
  await assert.rejects(acquireNativeArchiveLock(lock), /owns the lock/);
  const old = new Date(Date.now() - 2 * 365 * 86400_000);
  await utimes(lock, old, old);
  await (
    await acquireNativeArchiveLock(lock)
  )();
});

test("Codex resume retries a contended native restore and retains original thread", async (t) => {
  const f = await fixture(t, "codex");
  const { acquireNativeArchiveLock } =
    await import("../dist/native-archive.js");
  const env = { CODEX_HOME: f.home };
  const calls = [];
  const client = {
    request: async (method) => {
      calls.push(method);
      if (method === "thread/archive" || method === "thread/unarchive") {
        await mkdir(dirname(f.archived), { recursive: true });
        await rename(
          method === "thread/archive" ? f.active : f.archived,
          method === "thread/archive" ? f.archived : f.active,
        );
        return {};
      }
      return { thread: { id } };
    },
  };
  await archiveCodexThread(client, id, "archived", env);
  const release = await acquireNativeArchiveLock(
    join(f.home, "archived_sessions", ".foundry-archive", `${id}.lock`),
  );
  await rm(join(f.home, "archived_sessions", ".foundry-archive", `${id}.json`));
  const waiting = resumeCodexThread(client, { threadId: id }, env);
  await new Promise((resolve) => setTimeout(resolve, 150));
  await rename(f.archived, f.active);
  await release();
  assert.equal((await waiting).thread.id, id);
  assert.deepEqual(calls, ["thread/archive", "thread/resume"]);
});

test("complete long Codex headers retain descendants and invalid metadata fails before native mutation", async (t) => {
  const { codexDescendants } = await import("../dist/native-archive.js");
  const { nativeHistoryHeader } = await import("../dist/codex-history.js");
  const f = await fixture(t, "codex");
  const child = "22222222-2222-4222-8222-222222222222";
  const path = join(dirname(f.active), `rollout-${child}.jsonl`);
  const header = JSON.stringify({
    type: "session_meta",
    payload: {
      instructions: "x".repeat(300_000),
      id: child,
      cwd: f.workspace,
      parent_thread_id: id,
    },
  });
  await writeFile(path, header + "\n{}\n");
  assert.equal((await nativeHistoryHeader(path)).payload.id, child);
  assert.deepEqual(await codexDescendants(f.home, id), [child]);
  await writeFile(
    f.active,
    JSON.stringify({
      type: "session_meta",
      payload: { instructions: "y".repeat(300_000), id, cwd: f.workspace },
    }) + "\n",
  );
  // Dry-run also exercises workspace ownership against a >256 KB header.
  const old = process.env.CODEX_HOME;
  process.env.CODEX_HOME = f.home;
  t.after(() =>
    old === undefined
      ? delete process.env.CODEX_HOME
      : (process.env.CODEX_HOME = old),
  );
  const result = await applyNativeArchive(
    {
      provider: "codex",
      nativeSessionId: id,
      deviceId: "synthetic",
      workspacePath: f.workspace,
      desired: "archived",
      generation: 500,
    },
    false,
    true,
  );
  assert.equal(result.state, "active");
  assert.deepEqual(result.nativeDescendantIds, [child]);
  await writeFile(path, "{invalid header\n");
  await assert.rejects(
    archiveCodexThread(
      { request: async () => assert.fail("must not mutate native state") },
      id,
      "archived",
      { CODEX_HOME: f.home },
    ),
    /Cannot parse native history header/,
  );
  assert.ok(await stat(f.active));
});

test("forking an archived Claude source refuses without restoring native state", async (t) => {
  const f = await fixture(t);
  await archiveClaudeSession(f.home, id, "archived", {
    inUse: async () => false,
  });
  const before = await readFile(f.archived);
  await assert.rejects(
    restoreClaudeSessionForResume(
      id,
      { CLAUDE_CONFIG_DIR: f.home },
      f.workspace,
      true,
    ),
    /Cannot fork an archived/,
  );
  assert.deepEqual(await readFile(f.archived), before);
  await assert.rejects(stat(f.active), { code: "ENOENT" });
  assert.ok(
    await stat(f.archived.replace(/\.jsonl$/, ".foundry-archive.json")),
  );
});

test("Codex validates the native id before creating any archive lock paths", async (t) => {
  const f = await fixture(t, "codex");
  await assert.rejects(
    archiveCodexThread(
      { request: async () => assert.fail("no native call") },
      "../../outside",
      "active",
      { CODEX_HOME: f.home },
    ),
    /Invalid native session id/,
  );
  await assert.rejects(stat(join(f.home, "archived_sessions")), {
    code: "ENOENT",
  });
});
