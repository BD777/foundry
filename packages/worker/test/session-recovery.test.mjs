import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readAgentSessionCompletionMarker,
  recoveredSessionCompletion,
  writeAgentSessionCompletionMarker,
} from "../dist/session-helpers.js";

const session = (id, inputId) => ({
  id,
  input: { id: inputId, prompt: "work" },
});

test("an orphaned input reports the result this device recorded", () => {
  const workspace = mkdtempSync(join(tmpdir(), "foundry-recovery-"));
  writeAgentSessionCompletionMarker(workspace, session("sess_1", "in_2"), {
    response: "done offline",
    nativeSessionId: "native_1",
  });
  assert.deepEqual(recoveredSessionCompletion(workspace, "sess_1", "in_2"), {
    sessionId: "sess_1",
    inputId: "in_2",
    nativeSessionId: "native_1",
    response: "done offline",
  });
});

test("another input's marker never settles the orphaned one", () => {
  const workspace = mkdtempSync(join(tmpdir(), "foundry-recovery-"));
  writeAgentSessionCompletionMarker(workspace, session("sess_1", "in_1"), {
    response: "earlier answer",
  });
  assert.equal(
    readAgentSessionCompletionMarker(workspace, "sess_1", "in_2"),
    undefined,
  );
  const report = recoveredSessionCompletion(workspace, "sess_1", "in_2");
  assert.equal(report.response, undefined);
  assert.match(report.error, /result was lost/);
  assert.equal(report.inputId, "in_2");
});
