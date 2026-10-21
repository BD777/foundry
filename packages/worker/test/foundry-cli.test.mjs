import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(packageDir, "dist", "foundry-cli.js");

/** A Foundry server that records tool calls and answers each with reply. */
async function fakeTools(t, reply) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const message = JSON.parse(body);
      calls.push({
        path: req.url,
        authorization: req.headers.authorization,
        name: message.params?.name,
        arguments: message.params?.arguments,
      });
      const [text, isError] = reply(
        message.params?.name,
        message.params?.arguments,
      );
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text }], isError },
        }),
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  return { calls, url: `http://127.0.0.1:${server.address().port}` };
}

async function foundry(args, env = {}) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    env: { ...process.env, ...env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const [code] = await once(child, "exit");
  return { code, stdout, stderr };
}

test("session get and events read a session by link through the Foundry tools", async (t) => {
  const { calls, url } = await fakeTools(t, (name) => [
    name === "get_session" ? '{"id":"sess_9","status":"failed"}' : "events",
    false,
  ]);
  const env = {
    FOUNDRY_SERVER_URL: url,
    FOUNDRY_SESSION_TOKEN: "token-1",
    FOUNDRY_WORKSPACE_ID: "",
  };
  const link = "https://foundry.example/chats/sess_9?workspace=ws_a";

  const got = await foundry(["session", "get", link], env);
  assert.equal(got.code, 0, got.stderr);
  assert.equal(got.stdout.trim(), '{"id":"sess_9","status":"failed"}');

  const events = await foundry(
    [
      "session",
      "events",
      link,
      "--errors",
      "--level",
      "info",
      "--label",
      "Session failed,Waiting for background tasks",
      "--query",
      "idle timeout",
      "--tail",
      "20",
      "--context",
      "2",
      "--after",
      "2026-10-09T20:00:00Z",
      "--max-bytes",
      "5000",
    ],
    env,
  );
  assert.equal(events.code, 0, events.stderr);
  assert.equal(events.stdout.trim(), "events");
  assert.deepEqual(
    calls.map((call) => [call.path, call.authorization, call.name]),
    [
      ["/api/mcp", "Bearer token-1", "get_session"],
      ["/api/mcp", "Bearer token-1", "read_context"],
    ],
  );
  assert.deepEqual(calls[0].arguments, { sessionId: link });
  assert.deepEqual(calls[1].arguments, {
    sessionId: link,
    scope: "events",
    levels: ["error", "warning", "info"],
    labels: ["Session failed", "Waiting for background tasks"],
    query: "idle timeout",
    tail: 20,
    context: 2,
    after: "2026-10-09T20:00:00Z",
    maxBytes: 5000,
  });
  const page = await foundry(
    ["session", "events", "sess_9", "--limit", "10", "--before", "evt_1"],
    env,
  );
  assert.equal(page.code, 0, page.stderr);
  assert.deepEqual(calls[2].arguments, {
    sessionId: "sess_9",
    scope: "events",
    limit: 10,
    before: "evt_1",
  });
});

test("session events refuses bad flags and reports tool errors", async (t) => {
  const { calls, url } = await fakeTools(t, () => [
    "no session or chat sess_x that you can read",
    true,
  ]);
  const env = { FOUNDRY_SERVER_URL: url, FOUNDRY_SESSION_TOKEN: "token-1" };
  const badTail = await foundry(
    ["session", "events", "sess_x", "--tail", "many"],
    env,
  );
  assert.equal(badTail.code, 1);
  assert.match(badTail.stderr, /--tail needs a positive whole number/);
  const noId = await foundry(["session", "events", "--errors"], env);
  assert.equal(noId.code, 1);
  assert.match(noId.stderr, /foundry session events needs <sessionId>/);
  const unknown = await foundry(["session", "get", "sess_x", "--verbose"], env);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /foundry session get reads no --verbose/);
  assert.equal(calls.length, 0);
  const missing = await foundry(["session", "get", "sess_x"], env);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /no session or chat sess_x that you can read/);
});

test("workspace and device lists come from the Foundry tools", async (t) => {
  const { calls, url } = await fakeTools(t, (name) => [name, false]);
  const env = { FOUNDRY_SERVER_URL: url, FOUNDRY_SESSION_TOKEN: "token-1" };
  assert.equal(
    (await foundry(["workspace", "list"], env)).stdout.trim(),
    "list_workspaces",
  );
  assert.equal(
    (await foundry(["device", "list"], env)).stdout.trim(),
    "list_resources",
  );
  assert.deepEqual(
    calls.map((call) => call.arguments),
    [{}, {}],
  );
});

// The CLI is a client of the same tools sessions call: every command sends
// its tool the arguments its words and flags name, nothing else.
test("every command calls its tool with the arguments its flags set", async (t) => {
  const { calls, url } = await fakeTools(t, (name) => [
    `${name} answered`,
    false,
  ]);
  const session = { FOUNDRY_SERVER_URL: url, FOUNDRY_SESSION_TOKEN: "token-1" };
  const brief = join(mkdtempSync(join(tmpdir(), "foundry-brief-")), "brief.md");
  writeFileSync(brief, "Check the build\n");
  const runs = [
    [
      ["session", "list", "--parent-only", "--limit", "5"],
      "list_sessions",
      { parentOnly: true, limit: 5 },
    ],
    [
      ["session", "children", "sess_p"],
      "list_sessions",
      { parentSessionId: "sess_p" },
    ],
    [
      ["session", "thread", "sess_1", "--max-bytes", "900"],
      "read_context",
      { sessionId: "sess_1", scope: "thread", maxBytes: 900 },
    ],
    [
      ["session", "chat", "native_claude_1"],
      "read_context",
      { sessionId: "native_claude_1", scope: "transcript" },
    ],
    [
      ["session", "subagents", "sess_1", "--task", "task_1"],
      "read_context",
      { sessionId: "sess_1", scope: "subagents", taskId: "task_1" },
    ],
    [
      ["session", "changes", "sess_1", "--path", "/w/a.go", "--input", "inp_1"],
      "read_context",
      {
        sessionId: "sess_1",
        scope: "changes",
        path: "/w/a.go",
        inputId: "inp_1",
      },
    ],
    [
      ["session", "file", "sess_1", "--path", "/w/a.go"],
      "read_context",
      { sessionId: "sess_1", scope: "file", path: "/w/a.go" },
    ],
    [
      ["session", "background", "sess_1", "--task", "bash_1"],
      "read_context",
      { sessionId: "sess_1", scope: "background", taskId: "bash_1" },
    ],
    [
      [
        "session",
        "create",
        "--prompt-file",
        brief,
        "--verification",
        "--wait",
        "--timeout-ms",
        "60000",
        "--workspace",
        "ws_b",
      ],
      "create_session",
      {
        prompt: "Check the build\n",
        verification: true,
        wait: true,
        timeoutMs: 60000,
        workspaceId: "ws_b",
      },
    ],
    [
      ["session", "handoff", "sess_1", "--message", "go on"],
      "handoff_session",
      { sessionId: "sess_1", prompt: "go on" },
    ],
    [
      ["session", "send", "sess_1", "--message", "and the tests", "--wait"],
      "send_message",
      { sessionId: "sess_1", prompt: "and the tests", wait: true },
    ],
    [
      ["session", "cancel", "sess_1"],
      "cancel_session",
      { sessionId: "sess_1" },
    ],
    [
      ["session", "rename", "sess_1", "--title", "Build check"],
      "rename_session",
      { sessionId: "sess_1", title: "Build check" },
    ],
    [
      ["session", "group", "grp_1"],
      "list_group_sessions",
      { groupId: "grp_1" },
    ],
    [
      ["issue", "list", "--status", "blocked,verifying"],
      "list_issues",
      { status: ["blocked", "verifying"] },
    ],
    [["issue", "get", "ISS-7"], "get_issue", { issueId: "ISS-7" }],
    [
      ["profile", "list", "--runtime", "codex"],
      "list_profiles",
      { runtime: "codex" },
    ],
    [
      ["model", "list", "--profile", "claude_p"],
      "list_models",
      { profileId: "claude_p" },
    ],
    [
      ["workspace", "find", "the blog", "--limit", "2"],
      "find_workspace",
      { query: "the blog", limit: 2 },
    ],
    [
      ["workspace", "get", "ws_blog", "--include", "live,note"],
      "get_workspace",
      { workspaceId: "ws_blog", include: ["live", "note"] },
    ],
    [
      [
        "workspace",
        "create",
        "--name",
        "Blog",
        "--purpose",
        "Posts",
        "--source",
        "clone",
        "--url",
        "https://example.com/blog.git",
        "--skill",
        "writing",
        "--device",
        "dev_mac",
      ],
      "create_workspace",
      {
        name: "Blog",
        purpose: "Posts",
        source: { kind: "clone", url: "https://example.com/blog.git" },
        skills: ["writing"],
        deviceId: "dev_mac",
      },
    ],
    [
      [
        "workspace",
        "update",
        "ws_blog",
        "--name",
        "Old blog",
        "--add-skill",
        "a,b",
        "--remove-skill",
        "c",
        "--add-connector",
        "acct_1",
      ],
      "update_workspace",
      {
        workspaceId: "ws_blog",
        name: "Old blog",
        skills: { add: ["a", "b"], remove: ["c"] },
        connectors: { add: ["acct_1"] },
      },
    ],
    [
      ["workspace", "archive", "ws_blog", "--restore"],
      "archive_workspace",
      { workspaceId: "ws_blog", restore: true },
    ],
    [
      ["assistant", "remember", "add", "--content", "Likes tea", "--inferred"],
      "remember",
      { op: "add", item: { content: "Likes tea", inferred: true } },
    ],
    [
      [
        "assistant",
        "remember",
        "add",
        "--content",
        "Likes tea",
        "--quote",
        "I like tea",
      ],
      "remember",
      { op: "add", item: { content: "Likes tea", quote: "I like tea" } },
    ],
    [
      ["assistant", "remember", "forget", "--id", "mem_1"],
      "remember",
      { op: "forget", item: { id: "mem_1" } },
    ],
    [
      [
        "assistant",
        "rule",
        "--action",
        "archive_workspace",
        "--decision",
        "auto",
      ],
      "update_rules",
      { change: { action: "archive_workspace", decision: "auto" } },
    ],
    [
      ["assistant", "tasks", "--status", "running,asking"],
      "list_tasks",
      { status: ["running", "asking"] },
    ],
    [
      [
        "assistant",
        "item",
        "add",
        "--text",
        "Reply to the recruiters",
        "--when",
        "after work",
        "--at",
        "2026-10-15 19:00",
        "--remind",
        "--quote",
        "下班再搞",
      ],
      "update_list",
      {
        op: "add",
        item: {
          text: "Reply to the recruiters",
          when: "after work",
          at: "2026-10-15 19:00",
          remind: true,
          quote: "下班再搞",
        },
      },
    ],
    [
      ["assistant", "list", "--closed-since", "2026-10-13"],
      "read_list",
      { closedSince: "2026-10-13" },
    ],
  ];
  for (const [args, tool, expected] of runs) {
    const before = calls.length;
    const run = await foundry(args, session);
    assert.equal(run.code, 0, `${args.join(" ")}: ${run.stderr}`);
    assert.equal(run.stdout.trim(), `${tool} answered`);
    assert.equal(calls.length, before + 1);
    assert.equal(calls.at(-1).name, tool, args.join(" "));
    assert.deepEqual(calls.at(-1).arguments, expected, args.join(" "));
  }
});

test("a paired device's CLI names its workspace, and waits past one call", async (t) => {
  // The session settles on the third call; a call shorter than a second
  // times out at once, as the server's would.
  let waits = 0;
  const { calls, url } = await fakeTools(t, (name, args) => {
    if (name !== "wait_session") return ["[]", false];
    if (args.timeoutMs < 1000 || ++waits < 3)
      return ["timed out waiting for sess_1", true];
    return ['{"id":"sess_1","status":"completed"}', false];
  });
  const state = mkdtempSync(join(tmpdir(), "foundry-cli-state-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  writeFileSync(
    join(state, "daemon-config.json"),
    JSON.stringify({ serverURL: url, deviceCredential: "dev_secret" }),
  );
  const device = {
    FOUNDRY_SERVER_URL: "",
    FOUNDRY_SESSION_TOKEN: "",
    FOUNDRY_WORKSPACE_ID: "ws_device",
    FOUNDRY_STATE_ROOT: state,
  };
  const listed = await foundry(["session", "list"], device);
  assert.equal(listed.code, 0, listed.stderr);
  assert.equal(calls[0].authorization, undefined);
  assert.deepEqual(calls[0].arguments, { workspaceId: "ws_device" });

  const waited = await foundry(
    ["session", "wait", "sess_1", "--timeout-ms", "1300000"],
    device,
  );
  assert.equal(waited.code, 0, waited.stderr);
  assert.equal(waited.stdout.trim(), '{"id":"sess_1","status":"completed"}');
  assert.deepEqual(
    calls.slice(1).map((call) => call.arguments.timeoutMs),
    [600000, 600000, 600000],
    "each call waits at most ten minutes",
  );
  const short = await foundry(
    ["session", "wait", "sess_1", "--timeout-ms", "500"],
    device,
  );
  assert.equal(short.code, 1);
  assert.match(short.stderr, /timed out waiting for sess_1/);
  assert.ok(
    calls.slice(4).every((call) => call.arguments.timeoutMs <= 500),
    "no call waits past the time asked for",
  );
});

/** Every file of a skill folder, as paths relative to it. */
function skillFiles(root, prefix = "") {
  return readdirSync(join(root, prefix), { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? skillFiles(root, join(prefix, entry.name))
        : [join(prefix, entry.name)],
    )
    .sort();
}

test("the foundry skill ships with the CLI, same as the server's built-in, and installs", async () => {
  const listed = await foundry(["skill", "list"]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.deepEqual(listed.stdout.trim().split("\n"), ["foundry"]);
  const bundled = join(packageDir, "skills", "foundry");
  const builtin = resolve(
    packageDir,
    "../../apps/server/internal/builtinskills/foundry",
  );
  const files = skillFiles(bundled);
  assert.deepEqual(files, ["SKILL.md", join("references", "diagnosing.md")]);
  assert.deepEqual(skillFiles(builtin), files, "both copies hold one folder");
  for (const file of files) {
    assert.equal(
      readFileSync(join(bundled, file), "utf8"),
      readFileSync(join(builtin, file), "utf8"),
      `${file} differs between the CLI's copy and the server's built-in`,
    );
  }
  const printed = await foundry(["skill", "foundry"]);
  assert.equal(printed.stdout, readFileSync(join(builtin, "SKILL.md"), "utf8"));
  assert.equal((await foundry(["skill"])).stdout, printed.stdout);
  const root = mkdtempSync(join(tmpdir(), "foundry-skill-"));
  try {
    const installed = await foundry([
      "skill",
      "install",
      "foundry",
      "--dir",
      root,
    ]);
    assert.equal(installed.code, 0, installed.stderr);
    assert.deepEqual(skillFiles(join(root, "foundry")), files);
    for (const file of files) {
      assert.equal(
        readFileSync(join(root, "foundry", file), "utf8"),
        readFileSync(join(builtin, file), "utf8"),
      );
    }
    const unknown = await foundry(["skill", "install", "nope", "--dir", root]);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /no bundled skill nope/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inside a Foundry session the CLI never acts with the device credential", async (t) => {
  const { calls, url } = await fakeTools(t, () => ["[]", false]);
  const state = mkdtempSync(join(tmpdir(), "foundry-cli-state-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  writeFileSync(
    join(state, "daemon-config.json"),
    JSON.stringify({ serverURL: url, deviceCredential: "dev_secret" }),
  );
  const listed = await foundry(["session", "list"], {
    FOUNDRY_SERVER_URL: url,
    FOUNDRY_SESSION_TOKEN: "",
    FOUNDRY_SESSION_ID: "sess_agent",
    FOUNDRY_WORKSPACE_ID: "ws_device",
    FOUNDRY_STATE_ROOT: state,
  });
  assert.notEqual(listed.code, 0);
  assert.match(listed.stderr, /Foundry tools/);
  assert.equal(calls.length, 0, "no request carries the device credential");
});

test("Cloudflare commands use the scoped MCP tool and structured query", async (t) => {
  const { calls, url } = await fakeTools(t, () => ['{"success":true}', false]);
  const env = {
    FOUNDRY_SERVER_URL: url,
    FOUNDRY_SESSION_TOKEN: "fixture-session",
    FOUNDRY_WORKSPACE_ID: "",
  };
  const accounts = await foundry(["cloudflare", "accounts"], env);
  assert.equal(accounts.code, 0, accounts.stderr);
  assert.equal(calls[0].name, "cloudflare");
  assert.deepEqual(calls[0].arguments, { action: "accounts" });
  const read = await foundry(
    [
      "cloudflare",
      "read",
      "/zones",
      "--account",
      "xacc_fixture",
      "--query",
      '{"page":"2","per_page":"1"}',
    ],
    env,
  );
  assert.equal(read.code, 0, read.stderr);
  assert.equal(calls[1].name, "cloudflare");
  assert.deepEqual(calls[1].arguments, {
    action: "request",
    path: "/zones",
    accountId: "xacc_fixture",
    query: { page: "2", per_page: "1" },
  });
  const invalid = await foundry(
    ["cloudflare", "read", "/zones", "--query", "not-json"],
    env,
  );
  assert.notEqual(invalid.code, 0);
  assert.equal(calls.length, 2, "invalid JSON reached the server");
});
