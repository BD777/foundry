import test from "node:test";
import assert from "node:assert/strict";
import {
  registerSessionAmbientEnv,
  sessionAmbientEnvironment,
} from "../dist/session-ambient.js";

test("ambient env is scoped per session and unregisters", () => {
  const unregister = registerSessionAmbientEnv("sess_a", {
    serverURL: "http://127.0.0.1:31982",
    sessionToken: "tok_a",
    workspaceID: "ws_a",
  });

  assert.deepEqual(sessionAmbientEnvironment("sess_a"), {
    FOUNDRY_SERVER_URL: "http://127.0.0.1:31982",
    FOUNDRY_SESSION_TOKEN: "tok_a",
    FOUNDRY_WORKSPACE_ID: "ws_a",
  });
  assert.deepEqual(sessionAmbientEnvironment("sess_b"), {});
  assert.deepEqual(sessionAmbientEnvironment(undefined), {});

  unregister();
  assert.deepEqual(sessionAmbientEnvironment("sess_a"), {});
});

test("only daemon-dispatched, non-Issue sessions get their own TMPDIR", async () => {
  const { registerSessionAmbientEnv, sessionEnvironment } =
    await import("../dist/session-ambient.js");
  const profile = { id: "p", runtime: "claude", connectionType: "local_login" };
  const ambient = {
    serverURL: "http://s",
    sessionToken: "t",
    workspaceID: "w",
  };
  const unregister = registerSessionAmbientEnv("sess_tmp", ambient);
  const unregisterIssue = registerSessionAmbientEnv("sess_issue", ambient);
  try {
    const chat = sessionEnvironment("/w", profile, {
      id: "sess_tmp",
      input: { id: "i", prompt: "x" },
    });
    assert.match(chat.TMPDIR, /fdy-/);
    assert.equal(chat.TMP, chat.TMPDIR);
    const issue = sessionEnvironment("/w", profile, {
      id: "sess_issue",
      issueId: "iss_1",
      input: { id: "i", prompt: "x" },
    });
    assert.equal(issue.TMPDIR, process.env.TMPDIR);
    const executorTurn = sessionEnvironment("/w", profile, {
      id: "run_1_0",
      input: { id: "i", prompt: "x" },
    });
    assert.equal(executorTurn.TMPDIR, process.env.TMPDIR);
  } finally {
    unregister();
    unregisterIssue();
  }
});
