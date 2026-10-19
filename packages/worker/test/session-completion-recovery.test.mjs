import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonDispatch } from "../dist/daemon/dispatch.js";
import { registerSessionHandlers } from "../dist/daemon/handlers/sessions.js";
import { SessionExecutionRegistry } from "../dist/session-state.js";
import { writeAgentSessionCompletionMarker } from "../dist/session-helpers.js";

function fixture(t) {
  const workspace = mkdtempSync(join(tmpdir(), "completion-recovery-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const dispatch = new DaemonDispatch();
  registerSessionHandlers(dispatch);
  const registry = new SessionExecutionRegistry();
  const reports = [];
  const ctx = {
    sessionExecutions: registry,
    roster: { pathFor: () => workspace },
    sessionTransport: {
      send: (type, payload) => reports.push({ type, payload }),
    },
  };
  const request = (inputId = "input_done") =>
    dispatch.dispatch(
      {
        type: "recover_session",
        payload: { sessionId: "sess_done", inputId, workspaceId: "ws_test" },
      },
      ctx,
    );
  writeAgentSessionCompletionMarker(
    workspace,
    { id: "sess_done", input: { id: "input_done" } },
    {
      response: "A complete saved answer.",
      nativeSessionId: "native_original",
    },
  );
  return {
    registry,
    reports,
    request,
    corruptSavedResult: () =>
      writeFileSync(
        join(
          workspace,
          ".foundry",
          "sessions",
          "sess_done",
          "inputs",
          "input_done",
          "completion.json",
        ),
        "invalid json",
      ),
  };
}

test("reconnect recovers a completed input after its original report was lost", async (t) => {
  const { registry, reports, request } = fixture(t);
  registry.claim("sess_done", "input_done");
  registry.complete("sess_done", "input_done");
  assert.equal(registry.handled("sess_done", "input_done"), true);
  await request();
  assert.deepEqual(reports, [
    {
      type: "session_completed",
      payload: {
        sessionId: "sess_done",
        inputId: "input_done",
        nativeSessionId: "native_original",
        response: "A complete saved answer.",
      },
    },
  ]);
  assert.equal(
    registry.claim("sess_done", "input_done"),
    false,
    "recovery does not allow dispatch replay",
  );
  await request();
  assert.deepEqual(
    reports[1],
    reports[0],
    "a repeated recovery reports the same persisted result",
  );
});

test("recovery never finishes an active input even when its marker already exists", async (t) => {
  const { registry, reports, request } = fixture(t);
  registry.claim("sess_done", "input_done");
  await request();
  assert.deepEqual(reports, []);
  assert.deepEqual(registry.activeSessionIds(), ["sess_done"]);
});

test("recovery cannot substitute an earlier input's saved answer", async (t) => {
  const { registry, reports, request } = fixture(t);
  registry.claim("sess_done", "input_done");
  registry.complete("sess_done", "input_done");
  await request("input_other");
  assert.equal(reports[0].payload.inputId, "input_other");
  assert.equal(reports[0].payload.response, undefined);
  assert.match(reports[0].payload.error, /result was lost/);
});

test("an older completion remains scoped while a newer input is active", async (t) => {
  const { registry, reports, request } = fixture(t);
  registry.claim("sess_done", "input_done");
  registry.complete("sess_done", "input_done");
  registry.claim("sess_done", "input_new");
  await request();
  assert.equal(reports[0].payload.inputId, "input_done");
  assert.equal(registry.isActive("sess_done", "input_new"), true);
  await request("input_new");
  assert.equal(reports.length, 1);
});

test("a corrupt saved result is reported as an error without completing or replaying", async (t) => {
  const { registry, reports, request, corruptSavedResult } = fixture(t);
  registry.claim("sess_done", "input_done");
  registry.complete("sess_done", "input_done");
  corruptSavedResult();
  await assert.rejects(request(), SyntaxError);
  assert.deepEqual(reports, []);
  assert.equal(registry.claim("sess_done", "input_done"), false);
});
