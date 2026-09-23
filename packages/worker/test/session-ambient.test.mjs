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
