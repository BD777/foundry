import test from "node:test";
import assert from "node:assert/strict";
import { registerIssueSteering, steerIssue } from "../dist/issue-steering.js";
import { issueEnvironmentAction } from "../dist/issue-environment-rpc.js";

test("Issue steer is bound to the active attempt, propagates rejection and unregisters safely", async () => {
  const messages = [];
  const previous = registerIssueSteering("i", {
    runId: "old",
    send: async () => {},
  });
  const close = registerIssueSteering("i", {
    runId: "current",
    send: async (text) => {
      messages.push(text);
    },
  });
  previous();
  try {
    await assert.rejects(
      steerIssue("i", "old", "wrong attempt"),
      /no longer accepting/,
    );
    await assert.rejects(
      steerIssue("other", "current", "wrong Issue"),
      /no longer accepting/,
    );
    await assert.rejects(steerIssue("i", "current", " "), /1–32000/);
    await assert.rejects(
      steerIssue("i", "current", "你".repeat(11000)),
      /1–32000/,
    );
    const result = await issueEnvironmentAction({
      action: "steer",
      issueId: "i",
      workspaceId: "w",
      expectedRunId: "current",
      message: "  focus on mobile  ",
      revision: 0,
    });
    assert.equal(result.status, "steered");
    assert.deepEqual(messages, ["focus on mobile"]);
  } finally {
    close();
  }
  await assert.rejects(
    steerIssue("i", "current", "ended"),
    /no longer accepting/,
  );
  const reject = registerIssueSteering("i", {
    runId: "failed",
    send: async () => {
      throw new Error("Native harness unavailable");
    },
  });
  try {
    await assert.rejects(
      steerIssue("i", "failed", "retry"),
      /Native harness unavailable/,
    );
  } finally {
    reject();
  }
});
