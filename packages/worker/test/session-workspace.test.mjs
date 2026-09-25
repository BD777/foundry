import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sandboxAvailable } from "../dist/sandbox/index.js";
import { runWorkspaceSession } from "../dist/session/index.js";
import {
  cancelActiveSession,
  isAgentSessionCanceledError,
} from "../dist/session-helpers.js";

const supported = { skip: !sandboxAvailable("writable_tree") };

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "foundry-workspace-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tree = join(root, "candidate");
  const scratch = join(root, "scratch");
  const outside = join(root, "outside");
  for (const path of [tree, scratch, outside]) mkdirSync(path);
  return { root, tree, scratch, outside };
}

function run({ root, tree, scratch }, id, command, events) {
  return runWorkspaceSession({
    cwd: tree,
    session: {
      id,
      provider: "claude",
      workspaceId: "ws_test",
      threadId: id,
      agentId: "",
      deviceId: "",
      status: "running",
      title: "Orchestrated child",
      prompt: "Do the task",
      createdLabel: "now",
      updatedLabel: "now",
    },
    profile: { runtime: "claude", id: "stand_in", label: "Stand-in", command },
    emit: async (label, detail) => {
      events.push({ label, detail });
    },
    emitSetup: async () => {},
    reportNativeSessionId: () => {},
    sandbox: {
      profile: {
        kind: "writable_tree",
        policyFile: join(root, "session.sb"),
        workdir: tree,
        readRoots: [],
        writeRoots: [tree, scratch],
        protectedReadRoots: [],
        readOnlyDirectories: [],
        readOnlyPaths: [],
        connectSockets: [],
        executables: [],
        userFiles: "hidden",
      },
      env: {
        PATH: process.env.PATH,
        HOME: scratch,
        TMPDIR: scratch,
        FOUNDRY_EXECUTION_SESSION_ROOT: join(scratch, "sessions"),
      },
      stderrFile: join(root, "session.log"),
      ambient: {
        serverURL: "http://127.0.0.1:1",
        sessionToken: "token-for-this-session",
        workspaceID: "ws_test",
      },
    },
  });
}

test(
  "a sandboxed workspace session writes its candidate only and keeps its orchestration identity",
  supported,
  async (t) => {
    const paths = fixture(t);
    const events = [];
    const escape = join(paths.outside, "escape.txt");
    const result = await run(
      paths,
      "sess_sandboxed",
      [
        `printf "$FOUNDRY_SESSION_TOKEN" > token.txt`,
        "echo made > note.txt",
        `(echo x > '${escape}') 2>/dev/null`,
        "echo finished",
      ].join("; "),
      events,
    );
    assert.equal(result.response, "finished");
    assert.equal(readFileSync(join(paths.tree, "note.txt"), "utf8"), "made\n");
    assert.equal(existsSync(escape), false, "writes outside are refused");
    assert.equal(
      readFileSync(join(paths.tree, "token.txt"), "utf8"),
      "token-for-this-session",
      "the agent can still orchestrate with its session token",
    );
    const labels = events.map((event) => event.label);
    assert.ok(labels.includes("Started custom profile command"));
    assert.ok(labels.includes("Custom profile command finished"));
  },
);

test("cancel stops a sandboxed workspace session", supported, async (t) => {
  const paths = fixture(t);
  const events = [];
  const running = run(paths, "sess_cancel", "sleep 30", events);
  for (let wait = 0; !events.length && wait < 400; wait++)
    await new Promise((done) => setTimeout(done, 25));
  assert.ok(events.length, "the session started");
  await cancelActiveSession("sess_cancel");
  await assert.rejects(running, (error) => isAgentSessionCanceledError(error));
});
